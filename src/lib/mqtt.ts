import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getEnv, jsonMirrorEnabled } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import { effectByNumber } from "@/lib/effects";
import { describeDeviceError } from "@/lib/deviceErrors";
import { activeFaultCodes } from "@/lib/faults";
import { syncFaultEvents } from "@/lib/faultLog";
import { getTenancy, peekTenancy } from "@/lib/tenancy";
import { noteHealth, noteOtaSent } from "@/lib/otaGuard";
import { appendHealthLog } from "@/lib/healthLog";
import { pruneOldRecords } from "@/lib/retention";
import { noteDiscoveredGateway } from "@/lib/gatewayDiscovery";
import { linkDevicesByPartition } from "@/lib/gatewayLink";
import { intervalSeconds } from "@/lib/deviceWindows";
import {
  decodeBinUplink,
  forgetBrGateway,
  type BinUplinkResult,
  noteRejectedJson,
} from "@/lib/binUplink";
import { encodeBrCommand, encodeCommand, type BinaryCommand } from "@/lib/binproto/command";
import { ShortIdTable } from "@/lib/binproto/shortIds";
import type { BrCommandAction } from "@/lib/binproto/brFields";
import type { BrAck, BrMessage, BrTopologyPage } from "@/lib/binproto/brToJson";
import { TopologyAssembler } from "@/lib/binproto/brTopology";
import {
  noteFirmware as zoneNoteFirmware,
  onAck as zoneOnAck,
  onHello as zoneOnHello,
  onUplink as zoneOnUplink,
  registerZonePublisher,
} from "@/lib/zoneSync/engine";
import type { ZoneOp } from "@/lib/zoneSync/plan";
import { HELLO_TEXT } from "@/lib/binproto/toJson";
import {
  cmdTopic,
  parseJsonUplinkTopic,
  parseBinTopic,
  parseLwtTopic,
  jsonMirrorTopic,
  ALL_CMD,
  BIN_WILDCARD,
  CMD_QOS,
  UPLINK_QOS,
  JSON_DATA_WILDCARD,
  JSON_HEALTH_WILDCARD,
  LWT_WILDCARD,
  type UplinkSuffix,
} from "@/lib/topics";
import {
  parseUplink,
  levelToPercent,
  MAX_ARC_LEVEL,
  flagToBool,
  d4iIsOn,
  deviceHealthSchema,
  gatewayLwtSchema,
  isMaintenanceAction,
  isZoneAction,
  type Action,
  commandAckSchema,
  type CommandAck,
  type D4iPeriodic,
  type DeviceHealth,
  type MaintenanceAction,
  type OtaStatus,
} from "@/types/lighting";

/**
 * MQTT client singleton (HiveMQ Cloud, TLS). Tek uzun ömürlü Node process'te
 * yaşar; globalThis ile cache'lenir (HMR'da çift bağlantı olmasın).
 *
 * Topic şeması (ESP ekibi kontratı, bkz. src/lib/topics.ts). YALNIZCA binary
 * protokol kabul edilir ve gönderilir; JSON desteği kaldırıldı.
 *  - subscribe "+/bin"          → Meven:<MAC>/bin: cihazın TÜM uplink'i.
 *    lib/binUplink.ts çözer. İlk bayt 0x01 (lamba): iç JSON karşılığı
 *    routeUplink ile işlenir. İlk bayt 0x03 (Thread Border Router): ağ geçidi
 *    yoluna gider (handleBrUplink).
 *  - subscribe "+/lwt"          → Meven:<GW_ID>/lwt: ağ geçidinin bağlantı durumu
 *    (MQTT will mesajı, `{"online":…}`; veri değil).
 *  - subscribe "+/data", "+/health" → YALNIZCA görünürlük: eski (JSON) firmware
 *    hâlâ buraya basıyorsa mesaj işlenmez, admin kartında "JSON gönderen cihaz"
 *    olarak listelenir (noteRejectedJson).
 *  - publish   Meven:<MAC>/cmd  → tekil komut (binary v1, kısa u16 id)
 *  - publish   Meven:<slug>/cmd → bölge komutu (tek publish)
 *  - publish   Meven:all/cmd    → toplu komut
 */

const globalForMqtt = globalThis as unknown as {
  __fenerMqtt?: MqttClient;
};

export function getMqttClient(): MqttClient {
  if (globalForMqtt.__fenerMqtt) return globalForMqtt.__fenerMqtt;

  const env = getEnv();
  const client = mqtt.connect({
    protocol: "mqtts",
    host: env.MQTT_HOST,
    port: env.MQTT_PORT, // 8883
    username: env.MQTT_USER,
    password: env.MQTT_PASS,
    rejectUnauthorized: true,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log("[mqtt] connected (HiveMQ Cloud, TLS)");
    // /bin ve /lwt QoS 2 (UPLINK_QOS, bkz. topics.ts): tekrar ve kayıp yok;
    // bir-kezlik health alanları (idf_version, ağ adı) yalnızca bağlantı
    // başına bir kez geliyor. Etkin QoS cihazın yayın QoS'uyla sınırlıdır.
    client.subscribe(
      {
        [JSON_DATA_WILDCARD]: { qos: 0 },
        [JSON_HEALTH_WILDCARD]: { qos: 0 },
        [BIN_WILDCARD]: { qos: UPLINK_QOS },
        [LWT_WILDCARD]: { qos: UPLINK_QOS },
      },
      (err) => {
        if (err) console.error("[mqtt] subscribe error:", err.message);
      },
    );
  });

  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));

  client.on("message", (topic, payload) => {
    const binMac = parseBinTopic(topic);
    const lwtMac = binMac ? null : parseLwtTopic(topic);
    if (binMac) {
      void handleBinUplink(binMac, payload).catch((err) => console.error("[mqtt] message handler error:", err));
    } else if (lwtMac) {
      void handleGatewayLwt(lwtMac, payload).catch((err) => console.error("[mqtt] message handler error:", err));
    } else {
      rejectJsonUplink(topic, payload);
    }
  });

  globalForMqtt.__fenerMqtt = client;
  return client;
}

/**
 * Meven:<MAC>/data ve /health: eski (JSON) firmware'in uplink'i. İŞLENMEZ —
 * yalnızca binary protokol kabul edilir. Cihaz admin kartında listelenir ki
 * firmware'i güncellenmemiş cihaz sessizce "bağlantısız" kalmasın. HELLO
 * (bağlanınca /data'ya basılan düz "data" metni) sayılmaz.
 */
function rejectJsonUplink(topic: string, raw: Buffer): void {
  const parsed = parseJsonUplinkTopic(topic);
  if (!parsed) return;
  if (parsed.suffix === "data" && raw.toString().trim() === HELLO_TEXT) return;
  noteRejectedJson(parsed.mac, parsed.suffix);
}

/**
 * Meven:<MAC>/bin: binary paketi çözüp iç JSON karşılığını routeUplink'e verir.
 * Ret/atlama lib/binUplink.ts'te sayılır.
 *
 * Binary komut yanıtı (COMMAND_ACK): u16 id bellek içi `shortIds` eşlemesiyle
 * komutun UUID'sine (commands.request_id) çevrilip handleAck'e verilir.
 * Eşlenemeyen ack'te (restart sonrası, süresi geçmiş, id'siz CRC/biçim hatası)
 * "en son bekleyen komut" TAHMİNİ yapılmaz — ack'in id'si hep bizim verdiğimizdir,
 * bulunamıyorsa yanlış komutu vurmayalım.
 */
async function handleBinUplink(mac: string, payload: Buffer): Promise<void> {
  const result = await decodeBinUplink(mac, payload);
  mirrorJson(mac, result);
  // Ağ geçidi (0x03): kendi yolu. Bölge senkronu kancalarına girmez (gateway'e
  // zone komutu gitmemeli). Kayıtlı ağ geçidinden gelen 0x01 paketi
  // decodeBinUplink'te zaten atıldı (GATEWAY).
  if (result.kind === "br") return handleBrUplink(mac, result.msg);
  // Bölge aboneliği: HELLO = cihaz (yeniden) bağlandı → listeyi doğrula; her
  // geçerli paket = cihaz ayakta → bekleyen zone işi varsa sürdür.
  // Yan iştir: hatası paketin işlenmesini (last_seen, telemetri) asla durdurmamalı.
  try {
    if (result.kind === "hello") zoneOnHello(mac);
    else if (result.kind !== "skip") zoneOnUplink(mac);
  } catch (err) {
    console.error(`[zone] ${mac} uplink kancası hata verdi:`, err);
  }
  if (result.kind === "json") return routeUplink(mac, result.suffix, result.json);
  if (result.kind === "ack") {
    const parsed = commandAckSchema.safeParse(result.json);
    if (!parsed.success) {
      console.warn(`[mqtt] binary ack çözülemedi (${mac}): ${JSON.stringify(result.json)}`);
      return;
    }
    const ack = parsed.data;
    const requestId = typeof ack.id === "number" ? shortIds.resolve(ack.id) : undefined;
    if (ack.id != null && !requestId) {
      console.warn(`[mqtt] binary ack (${mac}) bilinmeyen komut id'si ${ack.id} — komut eşlenmedi`);
    }
    return handleAck(mac, { ...ack, id: requestId });
  }
  // hello / skip: yapılacak bir şey yok.
}

/**
 * İzleme aynası (`MQTT_JSON_MIRROR`, varsayılan kapalı): çözülen paketin JSON
 * karşılığı — Python köprüsünün çıktısının aynısı — `Meven:<MAC>/json/<data|
 * health>`'e, reddedilen paketin nedeni `/json/reject`'e basılır. Ack'teki id
 * cihazın gördüğü u16'dır. Yalnızca firmware ekibinin gözü içindir; backend bu
 * topic'leri dinlemez.
 */
function mirrorJson(mac: string, r: BinUplinkResult): void {
  if (!jsonMirrorEnabled(mac)) return;
  const [suffix, body]: ["data" | "health" | "reject", string] =
    r.kind === "skip"
      ? ["reject", JSON.stringify({ reason: r.outcome, detail: r.detail, hex: r.hex })]
      : r.kind === "hello"
        ? ["data", HELLO_TEXT]
        : r.kind === "br"
          ? r.msg.kind === "health"
            ? ["health", JSON.stringify(r.msg.json)]
            : ["data", JSON.stringify(r.msg.kind === "ack" ? r.msg.ack : r.msg.page)]
          : [r.suffix, JSON.stringify(r.json)];
  getMqttClient().publish(jsonMirrorTopic(mac, suffix), body, { qos: 0 });
}

/**
 * Çözülmüş binary paketin (lib/binproto/toJson) iç JSON'u: health ya da
 * d4i_periodic. Komut yanıtı buraya gelmez (handleBinUplink'te ayrı yol).
 */
async function routeUplink(mac: string, suffix: UplinkSuffix, json: unknown): Promise<void> {
  if (suffix === "health") {
    const h = deviceHealthSchema.safeParse(json);
    if (!h.success) {
      console.warn(`[mqtt] bilinmeyen health payload (${mac})`);
      return;
    }
    return handleHealth(mac, h.data);
  }

  const uplink = parseUplink(json);
  if (!uplink) {
    console.warn(`[mqtt] bilinmeyen payload (${mac})`);
    return;
  }
  if (uplink.kind === "ignored") return;
  if (uplink.kind === "d4i") return handleD4i(mac, uplink.data, json);
  return handleAck(mac, uplink.data);
}

/**
 * Cihazın son görülme zamanını tazeler ve bölgesini çözer. Cihaz kayıtlı
 * değilse (dashboard'a eklenmemiş MAC) zoneSlug undefined döner — veri yine
 * loglanır, sadece bölgeyle eşleşmez.
 */
async function touchDevice(
  mac: string,
  now: Date,
  patch?: Partial<
    Pick<
      typeof schema.devices.$inferInsert,
      | "lastError"
      | "lastErrorAt"
      | "firmwareVersion"
      | "health"
      | "healthAt"
      | "gatewayId"
      | "healthIntervalS"
      | "reportIntervalS"
    >
  >,
) {
  const [device] = await db
    .update(schema.devices)
    .set({ lastSeen: now, ...patch })
    .where(eq(schema.devices.deviceId, mac))
    .returning();

  if (!device?.zoneId) return { device, zone: undefined };

  const [zone] = await db
    .select()
    .from(schema.zones)
    .where(eq(schema.zones.id, device.zoneId))
    .limit(1);
  return { device, zone };
}

/**
 * Bir cihazı etkileyebilecek komut hedefleri: kendi MAC'i, admin'in global
 * "all"u, bölge slug'ı ve bölgenin müşterisinin slug'ı (müşteri "Tüm Sistem"i
 * `commands.target_id` = müşteri slug'ı ile kaydedilir).
 */
function commandTargets(mac: string, zone?: { slug: string; customerId: string }): string[] {
  // Alt grup komutları `commands.target_id` = grup slug'ı ile kaydedilir.
  const targets = [mac, "all", ...(peekTenancy()?.deviceGroups.get(mac) ?? [])];
  if (zone) {
    targets.push(zone.slug);
    const customerSlug = peekTenancy()?.customersById.get(zone.customerId)?.slug;
    if (customerSlug) targets.push(customerSlug);
  }
  return targets;
}

/** Cihazdan haber gelince o cihaza/bölgesine ait bekleyen komutları kapat. */
async function markDelivered(
  mac: string,
  zone: { slug: string; customerId: string } | undefined,
  now: Date,
) {
  const targets = commandTargets(mac, zone);
  await db
    .update(schema.commands)
    .set({ status: "delivered", deliveredAt: now })
    .where(
      and(
        inArray(schema.commands.targetId, targets),
        eq(schema.commands.status, "pending"),
      ),
    );
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/**
 * Postgres INTEGER sütununa yazılacak değer: tam sayıya yuvarlanır, int32
 * dışındaki değer null olur. Sürücü bellek bankası okunamayınca DALI "bilinmiyor"
 * için 0xFF.. döndürür (örn. operating_time_s = 4294967295); firmware ölçeklenmiş
 * değerleri ondalıklı da gönderebilir (sahada `input_voltage_v: 237.2`). İkisi de INSERT'i düşürür ve
 * o lambanın telemetrisi hiç yazılmaz — raporun tamamı yine `raw`'da kalır.
 */
function toInt(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const r = Math.round(v);
  return r >= INT32_MIN && r <= INT32_MAX ? r : null;
}

/**
 * D4i periyodik raporu: bir DALI adresinin (lambanın) durumu + sürücü/LED
 * telemetrisi. Cihaz-seviyesi (bölge snapshot'ı, device_status) değerler tek
 * mesajdan değil, cihazın TÜM lambalarının güncel satırlarından türetilir —
 * her mesaj yalnızca bir adresi taşıdığı için.
 */
async function handleD4i(mac: string, d: D4iPeriodic, raw: unknown): Promise<void> {
  const now = new Date();
  const ch = d.address;
  // 255 = DALI "MASK" (bilinmiyor / yanıt yok), bir seviye değil: arızalı
  // lambada gelir ve %100 sayılırsa sönük lamba tam açık görünür.
  const rawLevel = d.status?.actual_level;
  const level = typeof rawLevel === "number" && rawLevel <= MAX_ARC_LEVEL ? rawLevel : undefined;
  const isOn = d4iIsOn(d);
  // Lamba rozeti, bölge durumu ve arıza geçmişi aynı listeden karar verir.
  const faultCodes = activeFaultCodes(d, raw);
  const fault = faultCodes.length > 0;
  const brightness = typeof level === "number" ? levelToPercent(level) : undefined;

  // 1) Lamba (fixture) snapshot'ı
  const fxPatch: StatePatch & { status?: string; lastSeen?: Date } = {
    status: fault ? "fault" : "ok",
    lastSeen: now,
  };
  if (typeof isOn === "boolean") fxPatch.isOn = isOn;
  if (typeof brightness === "number") fxPatch.brightness = brightness;
  await upsertFixture(mac, ch, fxPatch);

  // 2) Ham D4i telemetrisi (detay paneli + ileride grafikler). Tam sayı
  // sütunları `toInt`'ten geçer. Yazım yine de başarısız olursa rapor loglanır
  // ama arıza geçmişi, cihaz özeti ve canlı yayın atlanmaz.
  const drv = d.d4i?.driver;
  const led = d.d4i?.led;
  try {
    await db.insert(schema.d4iTelemetry).values({
      deviceId: mac,
      channel: ch,
      online: d.online ?? null,
      d4iSupported: d.d4i_supported ?? false,
      statusByte: toInt(d.status?.status),
      actualLevel: toInt(level),
      minLevel: toInt(d.status?.min_level),
      maxLevel: toInt(d.status?.max_level),
      physicalMinLevel: toInt(d.status?.physical_min_level),
      lampFailure: flagToBool(d.status?.lamp_failure) ?? null,
      lampPowerOn: flagToBool(d.status?.lamp_power_on) ?? null,
      controlGearPresent: flagToBool(d.status?.control_gear_present) ?? null,
      energyWh: d.d4i?.energy?.value ?? null,
      powerW: d.d4i?.power?.value ?? null,
      driverTemperatureC: toInt(drv?.temperature_c),
      driverVoltageV: toInt(drv?.input_voltage_v),
      driverOperatingTimeS: toInt(drv?.operating_time_s),
      ledTemperatureC: toInt(led?.temperature_c),
      ledVoltageV: led?.voltage_v ?? null,
      ledCurrentA: led?.current_a ?? null,
      raw: (raw as Record<string, unknown>) ?? null,
    });
    pruneOldRecords("d4i_telemetry", now.getTime());
  } catch (err) {
    console.error(
      `[mqtt] d4i_telemetry yazılamadı (${mac} ch${ch}):`,
      err instanceof Error ? err.message : err,
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  // 3) Arıza geçmişi: yalnızca durum değiştiğinde satır açılır/kapanır.
  await syncFaultEvents(
    mac,
    ch,
    faultCodes.map((code) => ({ code })),
    now,
  );

  // 4) Kanal seviyesinde canlı yayın
  emitLiveEvent({
    deviceId: mac,
    channel: ch,
    isOn,
    brightness,
    status: fault ? "error" : "ok",
    kind: "telemetry",
    at: now.toISOString(),
  });

  // 5) Cihaz-seviyesi agregat: cihazın tüm lambalarının güncel satırları
  const rows = await db
    .select()
    .from(schema.fixtures)
    .where(eq(schema.fixtures.deviceId, mac));
  const onRows = rows.filter((f) => f.isOn);
  const aggIsOn = onRows.length > 0;
  const aggBrightness = onRows.length
    ? Math.round(onRows.reduce((a, f) => a + f.brightness, 0) / onRows.length)
    : 0;
  const aggFault = rows.some((f) => f.status === "fault");

  await db.insert(schema.deviceStatus).values({
    deviceId: mac,
    brightness: aggBrightness,
    relayStatus: aggIsOn ? "on" : "off",
    temperature: toInt(drv?.temperature_c),
    status: aggFault ? "error" : "ok",
  });

  // 6) Bölge snapshot'ı + bekleyen komutlar + cihaz seviyesi canlı yayın
  const { zone } = await touchDevice(mac, now);
  if (zone) {
    // YALNIZCA status (arıza) telemetriden güncellenir. Parlaklık/açık-kapalı
    // ALTTAN ÜSTE yayılmaz: bölge, kendisine (veya "Tüm Sistem"e) verilen son
    // komutu gösterir; cihaz telemetrisi bölge parlaklığını değiştirmez.
    await db
      .update(schema.zones)
      .set({ status: aggFault ? "fault" : "ok" })
      .where(eq(schema.zones.id, zone.id));
  }
  await markDelivered(mac, zone, now);

  emitLiveEvent({
    zoneSlug: zone?.slug,
    deviceId: mac,
    isOn: aggIsOn,
    brightness: aggBrightness,
    status: aggFault ? "error" : "ok",
    kind: "telemetry",
    at: now.toISOString(),
  });
}

/**
 * Komut yanıtı (binary COMMAND_ACK'in iç karşılığı): `{"status":"ok"}` ya da
 * `{"status":"error","error":"..."}`. `id` kısa id'den çevrilmiş UUID'dir
 * (= commands.request_id) → yanıt doğru komuta ve lambaya bağlanır. Hata
 * `devices.last_error`'da rozet için saklanır. Olaya bilerek `zoneSlug` konmaz: geçici bir komut hatası bölgeyi
 * arızalı göstermemeli (bölge durumu telemetriden gelir).
 *
 * Bakım komutlarının (commission/ota_check) yanıtı ayrı yoldan gider
 * (handleMaintenanceAck): lamba hatası değildir, rozete/arıza geçmişine yazılmaz.
 */
async function handleAck(mac: string, ack: CommandAck): Promise<void> {
  const now = new Date();
  const at = now.toISOString();
  const requestId = ack.id != null && UUID_RE.test(String(ack.id)) ? String(ack.id) : undefined;
  const flight = requestId ? inflight.get(requestId) : undefined;

  if (isZoneAction(ack.action) || flight?.zoneOp) return handleZoneAck(mac, ack, requestId, now);

  const maintenance = isMaintenanceAction(ack.action) ? ack.action : flight?.maintenance;
  if (maintenance) return handleMaintenanceAck(mac, ack, maintenance, requestId, now);

  if (ack.status === "ok") {
    if (requestId) await settleCommand(requestId, "delivered", now);
    const { zone } = await touchDevice(mac, now, { lastError: null, lastErrorAt: null });
    await markDelivered(mac, zone, now);
    // Başarılı yanıt rozeti temizler; geçmişteki açık komut hatasını da kapatır.
    await syncFaultEvents(mac, null, [], now);
    emitLiveEvent({ deviceId: mac, status: "ok", kind: "ack", requestId, at });
    return;
  }

  const message = (ack.error ?? "cihaz komutu işleyemedi").slice(0, 200);
  const info = describeDeviceError(message);
  console.warn(`[mqtt] komut hatası (${mac}) [${info.code}]: ${message}`);

  await touchDevice(mac, now, { lastError: message, lastErrorAt: now });

  // id ile birebir eşleşme; satır henüz yazılmadıysa (recordCommand after()'ta)
  // kanal bellek içi uçuş kaydından gelir. Eşlenemeyen yanıtta tahmin yapılmaz
  // (bkz. handleBinUplink); hata yine rozete ve arıza geçmişine yazılır.
  let channel: number | null | undefined;
  if (requestId) {
    const row = await settleCommand(requestId, "failed", now);
    if (row || flight) channel = row ? row.channel : (flight?.channel ?? null);
  }

  // Geçmişe cihaz seviyesinde (channel = null) yazılır. Aynı anda tek bir
  // komut hatası açık kalır — farklı bir hata gelirse öncekini kapatır
  // (devices.last_error ile aynı semantik).
  await syncFaultEvents(mac, null, [{ code: `command.${info.code}`, detail: message }], now);

  // Reddedilen komutun kanalı (id ile eşleştiyse): "bu channel DALI hattinda
  // bulunamadi" gibi kanala özgü hatalarda kullanıcıya hangi lamba olduğunu
  // göstermek için.
  emitLiveEvent({
    deviceId: mac,
    channel: channel ?? undefined,
    status: "error",
    error: message,
    errorCode: info.code,
    kind: "ack",
    requestId,
    at,
  });
}

/**
 * Bölge aboneliği komutunun (zone_add/remove/clear/list) yanıtı. Lamba hatası
 * değildir: `devices.last_error`'a, arıza geçmişine ve `commands`'a yazılmaz;
 * durum lib/zoneSync'te tutulur ve `kind:"zone_sync"` olayıyla yayınlanır.
 */
async function handleZoneAck(
  mac: string,
  ack: CommandAck,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  await touchDevice(mac, now);
  if (requestId) inflight.delete(requestId);
  await zoneOnAck(mac, ack, requestId);
}

/**
 * Bakım komutunun (commission / ota_check) yanıtı. `"ok"` işin bittiği değil,
 * cihazın isteği KABUL ettiği anlamına gelir: tarama sonucu d4i_periodic
 * raporlarıyla, OTA ilerlemesi /health ile gelir. Lamba hatası olmadığı için
 * `devices.last_error`'a ve arıza geçmişine yazılmaz.
 */
async function handleMaintenanceAck(
  mac: string,
  ack: CommandAck,
  action: MaintenanceAction,
  requestId: string | undefined,
  now: Date,
): Promise<void> {
  await touchDevice(mac, now);
  if (requestId) await settleCommand(requestId, ack.status === "ok" ? "delivered" : "failed", now);

  const error =
    ack.status === "error" ? (ack.error ?? "cihaz isteği reddetti").slice(0, 200) : undefined;
  if (error) console.warn(`[mqtt] bakım komutu reddedildi (${mac}, ${action}): ${error}`);

  emitLiveEvent({
    deviceId: mac,
    status: ack.status,
    kind: "maintenance",
    maintenanceAction: action,
    requestId,
    error,
    errorCode: error ? describeDeviceError(error).code : undefined,
    at: now.toISOString(),
  });
}

/**
 * Sağlık mesajı (Meven:<MAC>/health, ~30 sn): firmware sürümü + OTA durumu.
 * Mesaj başına satır açılmaz — `devices` satırı güncellenir. OTA koruması
 * (lib/otaGuard.ts) için bellek içi kopya da tutulur.
 */
async function handleHealth(mac: string, h: DeviceHealth): Promise<void> {
  const now = new Date();
  const firmwareVersion = h.firmware_version?.slice(0, 32) ?? null;
  const ota = h.ota ?? null;
  // Rapor aralıkları yalnızca ilk kayıtta (join) gelir; gelmediği mesajda
  // sütun ezilmez (bkz. lib/deviceWindows.ts).
  const healthIntervalS = intervalSeconds((h as Record<string, unknown>).health_interval_s);
  const reportIntervalS = intervalSeconds((h as Record<string, unknown>).report_interval_s);
  noteHealth(mac, { firmwareVersion, ota }, now.getTime());
  zoneNoteFirmware(mac, firmwareVersion);

  const { device } = await touchDevice(mac, now, {
    // Sürüm alanı gelmediyse eski değer ezilmez.
    ...(firmwareVersion ? { firmwareVersion } : {}),
    ...(healthIntervalS !== undefined ? { healthIntervalS } : {}),
    ...(reportIntervalS !== undefined ? { reportIntervalS } : {}),
    health: h as Record<string, unknown>,
    healthAt: now,
  });
  // Geçmiş (admin "Kayıtlar"): yalnızca kayıtlı cihaz — kayıtsız MAC birikmez.
  if (device) await appendHealthLog(mac, h as Record<string, unknown>, now);

  emitLiveEvent({
    deviceId: mac,
    status: "ok",
    kind: "health",
    firmwareVersion,
    ota,
    at: now.toISOString(),
  });
}

// ── Ağ geçidi (Thread Border Router, binary 0x03) ────────────

/** Sayfalı topoloji (BR_NEIGHBORS / BR_ROUTES) birleştiricisi — bellek içi. */
const globalForGw = globalThis as unknown as { __fenerBrTopology?: TopologyAssembler };
const brTopology = (globalForGw.__fenerBrTopology ??= new TopologyAssembler());

/**
 * Ağ geçidi paketi (Meven:<GW_ID>/bin, ilk bayt 0x03). Kayıtsız gateway DB'ye
 * yazılmaz, yalnızca admin'in "Keşfedilen ağ geçitleri" listesine düşer — 0x03
 * yalnızca Border Router'a ait olduğu için tür kesindir (thread_br). Kayıtlıysa
 * `gateways` satırı tek UPDATE ile güncellenir (mesaj başına satır yok):
 *   - health   → son health + firmware + son görülme; lamba bağı (partition)
 *   - topology → tur tamamlanınca `report.neighbors` / `report.routes`
 *   - ack      → gateway komutunun sonucu (commands + SSE)
 */
async function handleBrUplink(gatewayId: string, msg: BrMessage): Promise<void> {
  const now = new Date();
  const ownerId = (await getTenancy()).gatewayOwner.get(gatewayId);
  if (!ownerId) {
    const fw = msg.kind === "health" && typeof msg.json.fw === "string" ? msg.json.fw : null;
    noteDiscoveredGateway(gatewayId, { type: "thread_br", firmwareVersion: fw }, now);
    return;
  }
  if (msg.kind === "health") return handleGatewayHealth(gatewayId, ownerId, msg.json, now);
  if (msg.kind === "topology") return handleGatewayTopology(gatewayId, ownerId, msg.page, now);
  return handleGatewayAck(gatewayId, ownerId, msg.ack, now);
}

async function handleGatewayHealth(
  gatewayId: string,
  ownerId: string,
  health: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const firmwareVersion = typeof health.fw === "string" && health.fw ? health.fw.slice(0, 32) : null;
  // OTA koruması (lib/otaGuard.ts) cihazlarla aynı bellek içi kopyayı kullanır.
  noteHealth(gatewayId, { firmwareVersion, ota: (health.ota ?? null) as OtaStatus | null }, now.getTime());
  await db
    .update(schema.gateways)
    .set({
      lastSeen: now,
      online: true,
      health,
      healthAt: now,
      ...(firmwareVersion ? { firmwareVersion } : {}),
    })
    .where(eq(schema.gateways.gatewayId, gatewayId));

  // Lamba bağı yan iştir: hatası gateway'in durumunu yazmayı durdurmamalı.
  const partition = (health.thread as Record<string, unknown> | null | undefined)?.partition_id;
  try {
    const r = await linkDevicesByPartition(gatewayId, ownerId, typeof partition === "string" ? partition : null);
    if (r.linked || r.unlinked) {
      console.log(`[gateway] ${gatewayId}: ${r.linked} cihaz bağlandı, ${r.unlinked} bağ kaldırıldı (partition ${partition})`);
    }
  } catch (err) {
    console.error(`[gateway] ${gatewayId} lamba bağı güncellenemedi:`, err);
  }

  emitLiveEvent({
    kind: "gateway",
    gatewayId,
    customerId: ownerId,
    status: "ok",
    online: true,
    firmwareVersion,
    at: now.toISOString(),
  });
}

async function handleGatewayTopology(
  gatewayId: string,
  ownerId: string,
  page: BrTopologyPage,
  now: Date,
): Promise<void> {
  const snap = brTopology.add(gatewayId, page, now.getTime());
  if (!snap) return; // tur sürüyor
  if (snap.mismatch) {
    console.warn(
      `[gateway] ${gatewayId} ${snap.kind} turu ${snap.snapshotId}: TOTAL ${snap.total}, gelen ${snap.items.length} kayıt`,
    );
  }
  // Komşular ve rotalar ayrı turlarda tamamlanır; report'un diğer anahtarı korunur.
  const block = { snapshot_id: snap.snapshotId, at: now.toISOString(), total: snap.total, items: snap.items };
  await db
    .update(schema.gateways)
    .set({
      report: sql`coalesce(${schema.gateways.report}, '{}'::jsonb) || ${JSON.stringify({ [snap.kind]: block })}::jsonb`,
      reportAt: now,
      lastSeen: now,
      online: true,
    })
    .where(eq(schema.gateways.gatewayId, gatewayId));
  emitLiveEvent({
    kind: "gateway",
    gatewayId,
    customerId: ownerId,
    status: "ok",
    online: true,
    at: now.toISOString(),
  });
}

/**
 * Gateway komutunun (report_now / ota_check) yanıtı. Kısa id komutun UUID'sine
 * çevrilir; eşlenemezse tahmin yapılmaz. Lamba hatası değildir: rozete, arıza
 * geçmişine ve bildirim akışına yazılmaz — yalnızca gateway satırında gösterilir.
 */
async function handleGatewayAck(gatewayId: string, ownerId: string, ack: BrAck, now: Date): Promise<void> {
  const requestId = ack.id != null ? shortIds.resolve(ack.id) : undefined;
  if (ack.id != null && !requestId) {
    console.warn(`[mqtt] gateway ack (${gatewayId}) bilinmeyen komut id'si ${ack.id} — komut eşlenmedi`);
  }
  const flight = requestId ? inflight.get(requestId) : undefined;
  if (requestId) await settleCommand(requestId, ack.status === "ok" ? "delivered" : "failed", now);
  if (ack.error) console.warn(`[mqtt] gateway komutu reddedildi (${gatewayId}, ${ack.action}): ${ack.error}`);
  emitLiveEvent({
    kind: "gateway",
    gatewayId,
    customerId: ownerId,
    status: ack.status,
    online: true,
    presenceOnly: true,
    requestId,
    gatewayCommand: {
      requestId: requestId ?? null,
      action: ack.action ?? flight?.gatewayCommand ?? null,
      status: ack.status,
      error: ack.error,
      result: ack.result,
    },
    at: now.toISOString(),
  });
}

/**
 * Meven:<GW_ID>/lwt — retained `{"online":true}` (gateway bağlandı) ya da MQTT
 * will ile `{"online":false}` (bağlantı koptu). Son görülme ilerletilmez: panel
 * "en son ne zaman haber aldık"ı göstermeye devam eder; retained `true`
 * backend her yeniden bağlandığında da gelir. Kayıtsız kimlik yok sayılır.
 */
async function handleGatewayLwt(gatewayId: string, payload: Buffer): Promise<void> {
  const text = payload.toString().trim();
  if (!text) return; // retained mesaj silindi
  const ownerId = (await getTenancy()).gatewayOwner.get(gatewayId);
  if (!ownerId) return;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn(`[mqtt] gateway LWT çözülemedi (${gatewayId}): ${text.slice(0, 80)}`);
    return;
  }
  const parsed = gatewayLwtSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(`[mqtt] gateway LWT tanınmadı (${gatewayId}): ${text.slice(0, 80)}`);
    return;
  }
  const online = parsed.data.online;
  await db.update(schema.gateways).set({ online }).where(eq(schema.gateways.gatewayId, gatewayId));
  emitLiveEvent({
    kind: "gateway",
    gatewayId,
    customerId: ownerId,
    status: "ok",
    online,
    presenceOnly: true,
    at: new Date().toISOString(),
  });
}

/** Gateway silinince bellekteki yarım topoloji ve bir-kezlik health alanları unutulsun. */
export function forgetGatewayState(gatewayId: string): void {
  brTopology.forget(gatewayId);
  forgetBrGateway(gatewayId);
}

/** Aç/kapa/dim/efekt durum yaması — hem `zones` hem `fixtures` snapshot'ına uygulanır. */
type StatePatch = { isOn?: boolean; brightness?: number; activeFx?: number | null };

/** Komut payload'ından snapshot patch'i üretir (bölge veya lamba). */
function patchFor(action: Action, value?: number, number?: number): StatePatch {
  const patch: StatePatch = {};
  if (action === "on") {
    patch.isOn = true;
    patch.activeFx = null; // efekt durur
  } else if (action === "off") {
    patch.isOn = false;
    patch.activeFx = null;
  } else if (action === "dim") {
    patch.isOn = true;
    if (typeof value === "number") patch.brightness = value;
    patch.activeFx = null;
  } else if (action === "efekt") {
    patch.isOn = true;
    if (typeof number === "number") patch.activeFx = number;
  }
  return patch;
}

/** Tek lamba (fixture) satırını (deviceId, channel) upsert eder ve satırı döner. */
async function upsertFixture(
  deviceId: string,
  channel: number,
  patch: StatePatch & { status?: string; lastSeen?: Date },
) {
  const [row] = await db
    .insert(schema.fixtures)
    .values({ deviceId, channel, ...patch })
    .onConflictDoUpdate({
      target: [schema.fixtures.deviceId, schema.fixtures.channel],
      set: patch,
    })
    .returning();
  return row;
}

/**
 * Bir komutun tüm parametreleri. API gövdesiyle (commandRequestSchema) aynı
 * şekle sahip; route'lar `parsed.data`'yı doğrudan geçirebilir.
 */
export type CommandInput = {
  action: Action;
  value?: number;
  number?: number; // efekt no
  channel?: number; // tek lamba (DALI kanalı); yoksa tüm cihaz
  text?: string; // Mors metni (efekt 22)
};

/**
 * Kabloya gidecek kanal. `channel` YALNIZCA tek lamba hedeflendiğinde gider
 * (0-63); toplu komutta (tüm cihaz / bölge / tüm sistem) alan pakette HİÇ
 * yoktur, cihaz yokluğundan "tüm lambalar"ı anlar (broadcast 255 firmware'de
 * reddedilir). Tüm hattı birlikte süren efektlerde (`allLamps`, örn. Chase)
 * tek lamba seçilse bile kanal gönderilmez — cihaz reddeder.
 */
function wireChannel({
  action,
  number,
  channel,
}: Pick<CommandInput, "action" | "number" | "channel">): number | undefined {
  if (channel == null) return undefined;
  const fx = action === "efekt" && number != null ? effectByNumber(number) : undefined;
  return fx?.allLamps ? undefined : channel;
}

// ── Uçuştaki komutlar (ack ↔ komut eşleştirmesi) ─────────────
// Komut id'si (= commands.request_id) publish anında kabloya konur ve burada
// tutulur. Neden bellekte: `commands` INSERT'i after()'ta yapılır (Kural #10),
// cihazın yanıtı satır yazılmadan önce gelebilir. O durumda sonuç buraya
// yazılır ve INSERT 'pending' yerine onu kullanır (insertCommandRow).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INFLIGHT_TTL_MS = 10 * 60_000;

type CommandOutcome = "delivered" | "failed";
type Inflight = {
  /** Kabloya giden kanal (yoksa tüm lambalar) — hata olayına kesin kanal. */
  channel?: number;
  maintenance?: MaintenanceAction;
  /** Bölge aboneliği komutu (lib/zoneSync) — `commands`'a yazılmaz. */
  zoneOp?: ZoneOp["action"];
  /** Ağ geçidi komutu (report_now / ota_check). */
  gatewayCommand?: BrCommandAction;
  /** Satır yazılmadan gelen yanıtın sonucu. */
  outcome?: CommandOutcome;
  /** commands satırı yazıldı mı. */
  recorded?: boolean;
  at: number;
};

const globalForInflight = globalThis as unknown as { __fenerInflight?: Map<string, Inflight> };
const inflight = (globalForInflight.__fenerInflight ??= new Map<string, Inflight>());

function rememberInflight(requestId: string, entry: Omit<Inflight, "at">): void {
  const now = Date.now();
  for (const [id, e] of inflight) {
    if (now - e.at > INFLIGHT_TTL_MS) inflight.delete(id);
  }
  inflight.set(requestId, { ...entry, at: now });
}

// ── Kısa komut id'si (binary komut) ──────────────────────────
// Binary komutta id u16'dır; UUID kabloya çıkmaz. Neden tek sayaç / 2 bayt:
// lib/binproto/shortIds.ts. TTL inflight ile aynı.

const globalForShortIds = globalThis as unknown as { __fenerShortIds?: ShortIdTable };
const shortIds = (globalForShortIds.__fenerShortIds ??= new ShortIdTable(INFLIGHT_TTL_MS));

/**
 * Kablo komutunun (toWireCmd sonrası) binary karşılığı. Mors `text`'i yalnızca
 * doluysa gider: alan yokken cihaz son ayarlanan metni tekrar çalar.
 */
function toBinaryCommand(wire: CommandInput, id: number): BinaryCommand {
  if (wire.action !== "dim" && wire.action !== "efekt") {
    throw new Error(`binary'de karşılığı olmayan action: ${wire.action}`);
  }
  return wire.action === "dim"
    ? { action: "dim", id, value: wire.value, channel: wireChannel(wire) }
    : { action: "efekt", id, number: wire.number, text: wire.text || undefined, channel: wireChannel(wire) };
}

/**
 * Komut satırının sonucunu id ile yazar. `delivered` yalnızca bekleyen satırı
 * günceller (bölgedeki başka bir cihazın hatası ezilmesin); `failed` her
 * durumda yazılır. Satır henüz yoksa sonuç uçuş kaydına bırakılır.
 */
async function settleCommand(
  requestId: string,
  outcome: CommandOutcome,
  now: Date,
): Promise<{ channel: number | null } | undefined> {
  const where =
    outcome === "delivered"
      ? and(eq(schema.commands.requestId, requestId), eq(schema.commands.status, "pending"))
      : eq(schema.commands.requestId, requestId);
  const [row] = await db
    .update(schema.commands)
    .set(outcome === "delivered" ? { status: "delivered", deliveredAt: now } : { status: "failed" })
    .where(where)
    .returning({ channel: schema.commands.channel });

  if (!row) {
    const e = inflight.get(requestId);
    if (e && !e.recorded && e.outcome !== "failed") e.outcome = outcome;
  }
  return row;
}

/**
 * `commands` satırını yazar; yanıt satırdan önce geldiyse onun sonucunu
 * kullanır. INSERT beklenirken gelen yanıt kaybolmasın diye ardından bir kez
 * daha bakılır.
 */
async function insertCommandRow(values: typeof schema.commands.$inferInsert): Promise<void> {
  const flight = inflight.get(values.requestId);
  const initial = flight?.outcome;
  await db.insert(schema.commands).values({
    ...values,
    status: initial ?? "pending",
    deliveredAt: initial === "delivered" ? new Date() : undefined,
  });
  if (!flight) return;
  flight.recorded = true;
  if (flight.outcome && flight.outcome !== initial) {
    await settleCommand(values.requestId, flight.outcome, new Date());
  }
}

/**
 * `on`/`off` action'ı ESP tarafından işlenmiyor — firmware yalnızca `dim`'i
 * (0-100) tanıyor. Bu yüzden aç/kapa komutları kabloda `dim`'e çevrilir:
 * `on → dim 100`, `off → dim 0`. `channel` ve diğer alanlar korunur; yalnızca
 * kablo payload'ı değişir — `recordCommand` orijinal `on`/`off` action'ıyla
 * çağrıldığından snapshot/log (patchFor) aynı kalır ve optimistic UI bozulmaz.
 *
 * TÜM hedeflere uygulanır (cihaz, bölge, "Tüm Sistem"); firmware hiçbirinde
 * `on`/`off` kabul etmiyor.
 */
function toWireCmd(cmd: CommandInput): CommandInput {
  if (cmd.action === "on") return { ...cmd, action: "dim", value: 100 };
  if (cmd.action === "off") return { ...cmd, action: "dim", value: 0 };
  return cmd;
}

/**
 * Komutu MQTT'ye yayınla. SENKRON ve DB'ye dokunmaz — çağrıldığı anda, zaten
 * açık olan TLS bağlantısı üzerinden publish eder. DB yazımı ve SSE için
 * ayrıca recordCommand'ı çağır (bkz. route'lardaki `after()`); böylece Neon
 * round-trip'i komutun ESP'ye ulaşmasını geciktirmez.
 *
 * Her hedefte `on`/`off` action'ı kabloda `dim`'e çevrilir (bkz. toWireCmd).
 *
 * target:
 *  - "device" → Meven:<MAC>/cmd  (id = MAC). `channel` verilirse tek lamba, yoksa tüm cihaz.
 *  - "zone"     → bölgedeki HER cihazın Meven:<MAC>/cmd'si (id = bölge slug'ı)
 *  - "group"    → alt grubun HER üyesinin Meven:<MAC>/cmd'si (id = grup slug'ı)
 *  - "customer" → müşterinin HER cihazının Meven:<MAC>/cmd'si (id = müşteri
 *                 slug'ı) — müşterinin "Tüm Sistem"i. Meven:all/cmd diğer
 *                 müşterilerin cihazlarını da sürerdi.
 *  - "all"      → Meven:all/cmd (id = "all") — TÜM müşteriler; yalnızca admin.
 *
 * Cihazlar bölge / alt grup topic'lerini (Meven:<slug>/cmd) DİNLEMEZ
 * (firmware kararı, 2026-11); yalnızca kendi MAC topic'ini ve Meven:all/cmd'yi.
 * Bu yüzden toplu hedefler cihaz başına publish'e açılır. Hepsi aynı paketi
 * (tek requestId / tek kısa id) alır; MAC listesi tenancy index'inden gelir →
 * DB beklenmez (Kural #10). MAC topic'ine gelen komuta cihaz ack döner, yani
 * bölge/grup/"Tüm Sistem" komutları da cevaplıdır (handleAck MAC'i topic'ten bilir).
 */
// Publish anında (senkron, route handler'da ilk iş olarak) atanır — komutların
// gönderilme sırasını, arka plandaki recordCommand'ların bitiş sırasından
// bağımsız olarak korur. Frontend SSE'de bunu eski/yeni event ayrımı için kullanır.
let cmdSeq = 0;

export type CommandTarget = "device" | "zone" | "group" | "customer" | "all";

/**
 * Toplu hedefin (bölge / alt grup / müşteri) kayıtlı cihazları — senkron,
 * tenancy index'inden. Route'lar guard'da index'i zaten yüklemiştir; yoksa
 * fırlar (route → 502) ki komut sessizce hiçbir cihaza gitmeden "202" dönmesin.
 */
function fanoutMacs(target: "zone" | "group" | "customer", id: string): string[] {
  const idx = peekTenancy();
  if (!idx) throw new Error("kiracı index'i yüklenmedi; toplu komutun cihazları çözülemiyor");
  if (target === "zone") return idx.zoneMacs.get(id) ?? [];
  if (target === "group") return idx.groupMacs.get(id) ?? [];
  return idx.customersBySlug.get(id)?.macs ?? [];
}

export function publishCommand(
  target: CommandTarget,
  id: string,
  cmd: CommandInput,
): { requestId: string; seq: number } {
  const topics: string[] =
    target === "device"
      ? [cmdTopic(id)]
      : target === "all"
        ? [ALL_CMD]
        : fanoutMacs(target, id).map(cmdTopic);

  // Komut id'si publish'ten ÖNCE üretilir (= commands.request_id); kabloya
  // u16 kısa id gider, shortIds ack'te aynı UUID'ye geri çevirir.
  const requestId = randomUUID();
  // Tüm hedeflerde on/off → dim çevrilir (firmware on/off tanımıyor).
  const wire = toWireCmd(cmd);
  const client = getMqttClient();
  if (topics.length > 0) {
    const payload = Buffer.from(encodeCommand(toBinaryCommand(wire, shortIds.issue(requestId))));
    for (const topic of topics) client.publish(topic, payload, { qos: CMD_QOS });
  }
  rememberInflight(requestId, { channel: wireChannel(cmd) });

  return { requestId, seq: ++cmdSeq };
}

/**
 * Bakım komutu (commission / ota_check) — YALNIZCA tek cihaza (Meven:<MAC>/cmd).
 * Bölge ya da `all` hedefi bilerek yoktur: aynı anda OTA indiren cihazlar
 * Thread ağını tıkıyor (firmware ekibinin saha notu). Senkron, DB'ye dokunmaz;
 * kayıt için recordMaintenance'ı after()'ta çağır.
 */
export function publishMaintenance(mac: string, action: MaintenanceAction): { requestId: string } {
  const requestId = randomUUID();
  const payload = Buffer.from(encodeCommand({ action, id: shortIds.issue(requestId) }));
  getMqttClient().publish(cmdTopic(mac), payload, { qos: CMD_QOS });
  rememberInflight(requestId, { maintenance: action });
  if (action === "ota_check") noteOtaSent(mac);
  return { requestId };
}

/**
 * Bölge aboneliği komutu (lib/zoneSync motoru çağırır) — YALNIZCA binary,
 * YALNIZCA Meven:<MAC>/cmd (cihaz başka topic'ten geleni -21 ile reddeder).
 * Tekrar denemede aynı kısa id kullanılır ki ilk denemenin geç gelen ack'i de
 * eşleşsin. Senkron, DB'ye dokunmaz.
 */
function publishZoneOp(
  mac: string,
  op: ZoneOp,
  reuse?: { requestId: string; shortId: number },
): { requestId: string; shortId: number } {
  const requestId = reuse?.requestId ?? randomUUID();
  const shortId = reuse?.shortId ?? shortIds.issue(requestId);
  const payload = Buffer.from(encodeCommand({ action: op.action, id: shortId, zones: op.zones }));
  getMqttClient().publish(cmdTopic(mac), payload, { qos: CMD_QOS });
  rememberInflight(requestId, { zoneOp: op.action });
  return { requestId, shortId };
}
registerZonePublisher(publishZoneOp);

/**
 * Ağ geçidi komutu (Border Router, binary 0x03): `report_now` (hemen health +
 * topoloji gönder) ya da `ota_check`. YALNIZCA Meven:<GW_ID>/cmd; kısa id u16,
 * yanıt `/bin`'e 0x03 COMMAND_ACK olarak döner (handleGatewayAck). Senkron,
 * DB'ye dokunmaz (Kural #10); kayıt için recordGatewayCommand'ı after()'ta çağır.
 */
export function publishGatewayCommand(gatewayId: string, action: BrCommandAction): { requestId: string } {
  const requestId = randomUUID();
  const payload = Buffer.from(encodeBrCommand({ action, id: shortIds.issue(requestId) }));
  getMqttClient().publish(cmdTopic(gatewayId), payload, { qos: CMD_QOS });
  rememberInflight(requestId, { gatewayCommand: action });
  if (action === "ota_check") noteOtaSent(gatewayId);
  return { requestId };
}

/** publishGatewayCommand sonrası `commands` kaydı (target_type 'gateway'). */
export async function recordGatewayCommand(
  gatewayId: string,
  requestId: string,
  action: BrCommandAction,
  meta: CommandMeta,
): Promise<void> {
  await insertCommandRow({
    requestId,
    targetType: "gateway",
    targetId: gatewayId,
    userId: meta.userId,
    customerId: meta.customerId,
    channel: null,
    action,
    value: null,
  });
}

/** publishMaintenance sonrası `commands` kaydı (route'larda after() içinde). */
export async function recordMaintenance(
  mac: string,
  requestId: string,
  action: MaintenanceAction,
  meta: CommandMeta,
): Promise<void> {
  await insertCommandRow({
    requestId,
    targetType: "device",
    targetId: mac,
    userId: meta.userId,
    customerId: meta.customerId,
    channel: null,
    action,
    value: null,
  });
}

/** Komutu kimin, hangi müşteri adına verdiği (commands tablosu için). */
export type CommandMeta = { userId: string | null; customerId: string | null };

/**
 * Bölge/toplu komutta lamba (fixture) snapshot'larını da günceller.
 *
 * Bu olmadan `zones` "açık" görünürken cihazların `fixtures` satırları kapalı
 * kalıyordu: kullanıcı ana sayfadan bölgeyi/tüm sistemi açıyor, cihaz modalini
 * açtığında lambaları KAPALI görüyor ve tekrar "aç"a basıyordu — broker'da
 * beklenmedik `{"action":"on","channel":N}` komutlarının kaynağı buydu. Cihaz
 * kendi `d4i_periodic` raporunu yollayana kadar (kanal başına ~30 sn) yanlış
 * durum ekranda kalıyordu; cihaz hiç raporlamıyorsa hiç düzelmiyordu.
 *
 * `macs === null` → tüm cihazlar ("all" komutu).
 */
async function patchFixtures(
  macs: string[] | null,
  patch: StatePatch,
  at: string,
  seq: number,
): Promise<void> {
  if (macs?.length === 0) return;

  const q = db.update(schema.fixtures).set(patch);
  const rows = await (macs === null
    ? q.returning()
    : q.where(inArray(schema.fixtures.deviceId, macs)).returning());

  // Açık cihaz modali lambaları anında güncellesin diye kanal bazlı yayın.
  for (const f of rows) {
    emitLiveEvent({
      deviceId: f.deviceId,
      channel: f.channel,
      isOn: f.isOn,
      brightness: f.brightness,
      activeFx: f.activeFx,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
  }
}

/**
 * Cihazların "Tüm cihaz" snapshot'ı (`devices.master_on/master_brightness`).
 * Yalnızca cihaz seviyesi ve üstü (alt grup, bölge, "Tüm Sistem") komutlar
 * yazar; `off` şiddeti korur (patch'te brightness yok). `macs === null` → tümü.
 */
async function patchDeviceMaster(macs: string[] | null, patch: StatePatch): Promise<void> {
  if (macs?.length === 0) return;
  const set: { masterOn?: boolean; masterBrightness?: number } = {};
  if (typeof patch.isOn === "boolean") set.masterOn = patch.isOn;
  if (typeof patch.brightness === "number") set.masterBrightness = patch.brightness;
  if (Object.keys(set).length === 0) return;
  const q = db.update(schema.devices).set(set);
  await (macs === null ? q : q.where(inArray(schema.devices.deviceId, macs)));
}

/**
 * Tek lambaya komut (on/off/dim/tek lamba efekti) gelince: o lamba tüm hattı süren bir efektteyse
 * (Chase vb.) efekt cihazın tamamında durmuş sayılır — aynı efekti taşıyan
 * diğer lambaların `active_fx`'i de temizlenir. Web paneli bu durumda önce
 * kanalsız durdurma gönderir; bu, kanal komutunu doğrudan gönderen
 * istemcilerde (mobil, API) de snapshot'ın tutarlı kalmasını sağlar.
 */
async function clearGroupEffect(deviceId: string, channel: number, at: string, seq: number) {
  const [cur] = await db
    .select({ activeFx: schema.fixtures.activeFx })
    .from(schema.fixtures)
    .where(and(eq(schema.fixtures.deviceId, deviceId), eq(schema.fixtures.channel, channel)))
    .limit(1);
  const fx = cur?.activeFx;
  if (fx == null || !effectByNumber(fx)?.allLamps) return;

  const rows = await db
    .update(schema.fixtures)
    .set({ activeFx: null })
    .where(and(eq(schema.fixtures.deviceId, deviceId), eq(schema.fixtures.activeFx, fx)))
    .returning();
  for (const f of rows) {
    if (f.channel === channel) continue; // hedef lambanın olayı ayrıca yayınlanır
    emitLiveEvent({
      deviceId,
      channel: f.channel,
      isOn: f.isOn,
      brightness: f.brightness,
      activeFx: null,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
  }
}

/**
 * publishCommand sonrası DB kaydı + snapshot (bölge veya lamba) + canlı event.
 * Publish yolundan çıkarıldığı için gecikmesi kullanıcıya yansımaz; route'lar
 * bunu `after()` içinde çağırır.
 */
export async function recordCommand(
  target: CommandTarget,
  id: string,
  requestId: string,
  seq: number,
  cmd: CommandInput,
  meta: CommandMeta,
): Promise<void> {
  const { action, value, number } = cmd;
  // Tüm hattı süren efekt kabloda kanalsız gider (wireChannel) → cihazın
  // TÜM lambaları başlar. Snapshot da öyle işaretlensin; aksi halde istemci
  // kanal gönderdiğinde yalnızca o lamba "efektte" görünürdü.
  const groupFx = action === "efekt" && !!effectByNumber(number)?.allLamps;
  const channel = groupFx ? undefined : cmd.channel;
  const at = new Date().toISOString();

  await insertCommandRow({
    requestId,
    targetType: target,
    targetId: id,
    userId: meta.userId,
    customerId: meta.customerId,
    channel: channel ?? null,
    action,
    value: action === "efekt" ? number : value, // commands log
  });

  if (target === "device") {
    // Optimistic lamba snapshot'ı: tek kanal ya da cihazın tüm bilinen lambaları.
    const patch = patchFor(action, value, number);
    if (channel != null) {
      await clearGroupEffect(id, channel, at, seq);
      const fx = await upsertFixture(id, channel, patch);
      if (fx) {
        emitLiveEvent({
          deviceId: id,
          channel,
          isOn: fx.isOn,
          brightness: fx.brightness,
          activeFx: fx.activeFx,
          status: "ok",
          kind: "command",
          at,
          seq,
        });
      }
    } else {
      await patchDeviceMaster([id], patch);
      const updated = await db
        .update(schema.fixtures)
        .set(patch)
        .where(eq(schema.fixtures.deviceId, id))
        .returning();
      for (const f of updated) {
        emitLiveEvent({
          deviceId: id,
          channel: f.channel,
          isOn: f.isOn,
          brightness: f.brightness,
          activeFx: f.activeFx,
          status: "ok",
          kind: "command",
          at,
          seq,
        });
      }
      // Cihaz-seviyesi ("Tüm cihaz") echo'su: kanal taşımayan bu olay, açık
      // modallerin "Tüm cihaz" kontrolünü (yerel + cross-client) günceller.
      // Lamba (kanal) olayları buraya bubble ETMEZ; bu yalnızca cihaz-seviyesi
      // komutun kendi echo'sudur.
      emitLiveEvent({
        deviceId: id,
        isOn: patch.isOn,
        brightness: patch.brightness,
        activeFx: patch.activeFx,
        status: "ok",
        kind: "command",
        at,
        seq,
      });
    }
    return; // cihaz komutunda bölge snapshot işi yok
  }

  if (target === "group") {
    // Alt grup: bölge snapshot'ı değişmez (bölgenin tamamı değil), üyelerin
    // lamba snapshot'ı + cihaz seviyesi echo'su yayınlanır.
    const patch = patchFor(action, value, number);
    const macs = [...((await getTenancy()).groupMacs.get(id) ?? [])];
    await patchDeviceMaster(macs, patch);
    await patchFixtures(macs, patch, at, seq);
    for (const mac of macs) {
      emitLiveEvent({
        deviceId: mac,
        isOn: patch.isOn,
        brightness: patch.brightness,
        activeFx: patch.activeFx,
        status: "ok",
        kind: "command",
        at,
        seq,
      });
    }
    return;
  }

  if (target === "zone") {
    const [zone] = await db
      .update(schema.zones)
      .set(patchFor(action, value, number))
      .where(eq(schema.zones.slug, id))
      .returning();
    if (!zone) {
      console.warn(`[mqtt] bilinmeyen zone slug'ı: ${id} (publish yine de gitti)`);
      return;
    }
    const macs = await db
      .select({ mac: schema.devices.deviceId })
      .from(schema.devices)
      .where(eq(schema.devices.zoneId, zone.id));
    const zonePatch = patchFor(action, value, number);
    await patchDeviceMaster(
      macs.map((d) => d.mac),
      zonePatch,
    );
    await patchFixtures(
      macs.map((d) => d.mac),
      zonePatch,
      at,
      seq,
    );
    emitLiveEvent({
      zoneSlug: zone.slug,
      isOn: zone.isOn,
      brightness: zone.brightness,
      activeFx: zone.activeFx,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
    return;
  }

  // customer ("Tüm Sistem" — bir müşterinin tüm bölgeleri) ya da all (admin global)
  const allPatch = patchFor(action, value, number);
  const idx = await getTenancy();

  let customerIds: string[];
  let updated: (typeof schema.zones.$inferSelect)[];
  if (target === "customer") {
    const cid = meta.customerId;
    if (!cid) {
      console.warn(`[mqtt] müşteri komutu müşterisiz kaydedildi: ${id}`);
      return;
    }
    customerIds = [cid];
    updated = await db
      .update(schema.zones)
      .set(allPatch)
      .where(eq(schema.zones.customerId, cid))
      .returning();
    const customerMacs = [...(idx.customersById.get(cid)?.macs ?? [])];
    await patchDeviceMaster(customerMacs, allPatch);
    await patchFixtures(customerMacs, allPatch, at, seq);
  } else {
    customerIds = [...idx.customersById.keys()];
    updated = await db.update(schema.zones).set(allPatch).returning();
    await patchDeviceMaster(null, allPatch);
    await patchFixtures(null, allPatch, at, seq);
  }

  for (const z of updated) {
    emitLiveEvent({
      zoneSlug: z.slug,
      customerId: z.customerId,
      isOn: z.isOn,
      brightness: z.brightness,
      activeFx: z.activeFx,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
  }
  // Master (Tüm Sistem) slider'ı için kapsam olayı: bölge olayları master'ı
  // OYNATMAZ (tek bölge değişimi master'ı kaydırmasın diye), master yalnızca bu
  // scope:"all" olayıyla senkronlanır. `brightness` yalnızca dim'de dolu
  // (patchFor), böylece on/off/efekt master seviyesini değiştirmez.
  // Olay müşteri başına üretilir: her panel yalnızca kendi master'ını görür.
  for (const customerId of customerIds) {
    emitLiveEvent({
      scope: "all",
      customerId,
      isOn: allPatch.isOn,
      brightness: allPatch.brightness,
      activeFx: allPatch.activeFx,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
  }
}
