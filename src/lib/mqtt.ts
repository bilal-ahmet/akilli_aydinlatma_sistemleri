import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import { effectByNumber } from "@/lib/effects";
import { describeDeviceError } from "@/lib/deviceErrors";
import { activeFaultCodes } from "@/lib/faults";
import { syncFaultEvents } from "@/lib/faultLog";
import { getTenancy, peekTenancy } from "@/lib/tenancy";
import { noteHealth, noteOtaSent } from "@/lib/otaGuard";
import { isGatewayPayload, nodeMacsFromReport } from "@/lib/gateways";
import { noteDiscoveredGateway } from "@/lib/gatewayDiscovery";
import { normalizeMac } from "@/lib/mac";
import {
  cmdTopic,
  zoneCmdTopic,
  parseUplinkTopic,
  ALL_CMD,
  DATA_WILDCARD,
  HEALTH_WILDCARD,
  type UplinkSuffix,
} from "@/lib/topics";
import {
  parseUplink,
  levelToPercent,
  flagToBool,
  d4iIsOn,
  d4iHasFault,
  deviceHealthSchema,
  gatewayUplinkSchema,
  isMaintenanceAction,
  type Action,
  type CommandAck,
  type CommandPayload,
  type D4iPeriodic,
  type DataPayload,
  type DeviceHealth,
  type MaintenanceAction,
} from "@/types/lighting";

/**
 * MQTT client singleton (HiveMQ Cloud, TLS). Tek uzun ömürlü Node process'te
 * yaşar; globalThis ile cache'lenir (HMR'da çift bağlantı olmasın).
 *
 * Topic şeması (ESP ekibi kontratı, bkz. src/lib/topics.ts):
 *  - subscribe "+/data"         → Meven:<MAC>/data mesajlarını işle
 *  - subscribe "+/health"       → Meven:<MAC>/health (firmware sürümü, OTA durumu)
 *  Gateway'ler de AYNI topic'leri kullanır (Meven:<GW_ID>/data|health); ayrım
 *  payload'daki `type` ile yapılır (bkz. handleUplink, lib/gateways.ts).
 *  - publish   Meven:<MAC>/cmd  → tekil komut
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
    client.subscribe([DATA_WILDCARD, HEALTH_WILDCARD], { qos: 0 }, (err) => {
      if (err) console.error("[mqtt] subscribe error:", err.message);
    });
  });

  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));

  client.on("message", (topic, payload) => {
    void handleUplink(topic, payload).catch((err) =>
      console.error("[mqtt] message handler error:", err),
    );
  });

  globalForMqtt.__fenerMqtt = client;
  return client;
}

/**
 * Meven:<MAC>/data ve Meven:<MAC>/health mesajlarını işle. /data'da üç ayrı
 * kontrat akıyor (bkz. types/lighting.ts parseUplink):
 *   - `{"type":"d4i_periodic", ...}` → DALI adresi başına durum + D4i telemetrisi
 *   - `{"status":"ok"|"error", ...}` → komutun cihazda işlenme sonucu
 *   - `{"deviceId": ...}`           → ilk kontrattaki tek/çok-lamba raporu
 * İlk iki formatta payload'da MAC yok; kimlik topic'ten okunur.
 */
async function handleUplink(topic: string, raw: Buffer): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    console.warn(`[mqtt] JSON çözülemedi (${topic})`);
    return;
  }

  const parsedTopic = parseUplinkTopic(topic);

  // Gateway'ler cihazlarla aynı topic'lere basar. Ayrım payload'dan (`type`
  // gateway türü) ya da kimlik kayıtlı bir gateway'e aitse ondan yapılır —
  // ikincisi kontrata uymayan (type'sız) bir gateway mesajını cihaz yoluna
  // düşürmemek için.
  if (
    parsedTopic &&
    (isGatewayPayload(json) || peekTenancy()?.gatewayOwner.has(parsedTopic.mac))
  ) {
    return handleGatewayUplink(parsedTopic.mac, parsedTopic.suffix, json);
  }

  if (parsedTopic?.suffix === "health") {
    const h = deviceHealthSchema.safeParse(json);
    if (!h.success) {
      console.warn(`[mqtt] bilinmeyen health payload (${topic})`);
      return;
    }
    return handleHealth(parsedTopic.mac, h.data);
  }

  const uplink = parseUplink(json);
  if (!uplink) {
    console.warn(`[mqtt] bilinmeyen payload (${topic})`);
    return;
  }

  // Eski kontratta MAC payload'da, yenilerde yalnızca topic'te.
  const mac = uplink.kind === "legacy" ? uplink.data.deviceId : (parsedTopic?.mac ?? null);
  if (!mac) {
    console.warn(`[mqtt] MAC çözülemedi (${topic})`);
    return;
  }

  if (uplink.kind === "d4i") return handleD4i(mac, uplink.data, json);
  if (uplink.kind === "ack") return handleAck(mac, uplink.data);
  return handleLegacyData(mac, uplink.data);
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
      "lastError" | "lastErrorAt" | "firmwareVersion" | "health" | "healthAt" | "gatewayId"
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
  const targets = [mac, "all"];
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

/**
 * D4i periyodik raporu: bir DALI adresinin (lambanın) durumu + sürücü/LED
 * telemetrisi. Cihaz-seviyesi (bölge snapshot'ı, device_status) değerler tek
 * mesajdan değil, cihazın TÜM lambalarının güncel satırlarından türetilir —
 * her mesaj yalnızca bir adresi taşıdığı için.
 */
async function handleD4i(mac: string, d: D4iPeriodic, raw: unknown): Promise<void> {
  const now = new Date();
  const ch = d.address;
  const level = d.status?.actual_level;
  const isOn = d4iIsOn(d);
  const fault = d4iHasFault(d);
  const brightness = typeof level === "number" ? levelToPercent(level) : undefined;

  // 1) Lamba (fixture) snapshot'ı
  const fxPatch: StatePatch & { status?: string; lastSeen?: Date } = {
    status: fault ? "fault" : "ok",
    lastSeen: now,
  };
  if (typeof isOn === "boolean") fxPatch.isOn = isOn;
  if (typeof brightness === "number") fxPatch.brightness = brightness;
  await upsertFixture(mac, ch, fxPatch);

  // 2) Ham D4i telemetrisi (detay paneli + ileride grafikler)
  const drv = d.d4i?.driver;
  const led = d.d4i?.led;
  await db.insert(schema.d4iTelemetry).values({
    deviceId: mac,
    channel: ch,
    online: d.online ?? null,
    d4iSupported: d.d4i_supported ?? false,
    statusByte: d.status?.status ?? null,
    actualLevel: level ?? null,
    minLevel: d.status?.min_level ?? null,
    maxLevel: d.status?.max_level ?? null,
    physicalMinLevel: d.status?.physical_min_level ?? null,
    lampFailure: flagToBool(d.status?.lamp_failure) ?? null,
    lampPowerOn: flagToBool(d.status?.lamp_power_on) ?? null,
    controlGearPresent: flagToBool(d.status?.control_gear_present) ?? null,
    energyWh: d.d4i?.energy?.value ?? null,
    powerW: d.d4i?.power?.value ?? null,
    driverTemperatureC: drv?.temperature_c ?? null,
    driverVoltageV: drv?.input_voltage_v ?? null,
    driverOperatingTimeS: drv?.operating_time_s ?? null,
    ledTemperatureC: led?.temperature_c ?? null,
    ledVoltageV: led?.voltage_v ?? null,
    ledCurrentA: led?.current_a ?? null,
    raw: (raw as Record<string, unknown>) ?? null,
  });

  // 3) Arıza geçmişi: yalnızca durum değiştiğinde satır açılır/kapanır.
  await syncFaultEvents(
    mac,
    ch,
    activeFaultCodes(d, raw).map((code) => ({ code })),
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
    temperature: drv?.temperature_c ?? null,
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
 * Komut yanıtı: `{"status":"ok"}` ya da `{"status":"error","error":"..."}`.
 * Firmware 1.0.9+ komutun `action`'ını ve gönderilen `id`'yi (= commands.
 * request_id) geri yollar → yanıt doğru komuta ve lambaya bağlanır. id'siz
 * yanıtta (eski firmware, "gecersiz json") hata o cihaza (ya da bölgesine)
 * giden EN SON bekleyen komuta yazılır. Hata `devices.last_error`'da rozet için
 * saklanır. Olaya bilerek `zoneSlug` konmaz: geçici bir komut hatası bölgeyi
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

  const { zone } = await touchDevice(mac, now, { lastError: message, lastErrorAt: now });

  // Önce id ile birebir eşleşme; satır henüz yazılmadıysa (recordCommand
  // after()'ta) kanal bellek içi uçuş kaydından gelir.
  let channel: number | null | undefined;
  let matched = false;
  if (requestId) {
    const row = await settleCommand(requestId, "failed", now);
    if (row || flight) {
      matched = true;
      channel = row ? row.channel : (flight?.channel ?? null);
    }
  }

  // Yedek: id yok ya da tanınmıyor → o cihaza giden en son bekleyen komut.
  if (!matched) {
    const targets = commandTargets(mac, zone);
    const [latest] = await db
      .select({ id: schema.commands.id, channel: schema.commands.channel })
      .from(schema.commands)
      .where(
        and(
          inArray(schema.commands.targetId, targets),
          eq(schema.commands.status, "pending"),
        ),
      )
      .orderBy(desc(schema.commands.createdAt))
      .limit(1);
    if (latest) {
      await db
        .update(schema.commands)
        .set({ status: "failed" })
        .where(eq(schema.commands.id, latest.id));
    }
    channel = latest?.channel;
  }

  // Geçmişe cihaz seviyesinde (channel = null) yazılır. Aynı anda tek bir
  // komut hatası açık kalır — farklı bir hata gelirse öncekini kapatır
  // (devices.last_error ile aynı semantik).
  await syncFaultEvents(mac, null, [{ code: `command.${info.code}`, detail: message }], now);

  // Reddedilen komutun kanalı: id ile eşleştiyse kesin, değilse en iyi tahmin
  // ("bu channel DALI hattinda bulunamadi" gibi kanala özgü hatalarda
  // kullanıcıya hangi lamba olduğunu göstermek için).
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
  // Cihaz bağlı olduğu gateway'i kendisi bildirebilir (gateway `nodes`
  // listesi veremiyorsa). Alan gelmezse mevcut bağ korunur.
  const gatewayId = h.gateway ? normalizeMac(h.gateway) : null;
  noteHealth(mac, { firmwareVersion, ota }, now.getTime());

  await touchDevice(mac, now, {
    // Sürüm alanı gelmediyse eski değer ezilmez.
    ...(firmwareVersion ? { firmwareVersion } : {}),
    ...(gatewayId ? { gatewayId } : {}),
    health: h as Record<string, unknown>,
    healthAt: now,
  });

  emitLiveEvent({
    deviceId: mac,
    status: "ok",
    kind: "health",
    firmwareVersion,
    ota,
    at: now.toISOString(),
  });
}

/**
 * Son yazılan `nodes` eşleşmesi (gateway başına) — rapor ~30 sn'de bir gelir,
 * liste değişmedikçe `devices` tablosuna yazılmaz.
 */
const globalForGw = globalThis as unknown as { __fenerGwNodes?: Map<string, string> };
const lastNodeSig = (globalForGw.__fenerGwNodes ??= new Map());

/**
 * Gateway mesajı (Meven:<GW_ID>/health veya /data). Kayıtsız gateway DB'ye
 * yazılmaz, yalnızca admin'in "keşfedilen" listesine düşer. Kayıtlıysa
 * `gateways` satırı tek UPDATE ile güncellenir (mesaj başına satır yok):
 *   - health → firmware + son health; `online:false` (LWT) yalnızca durumu düşürür
 *   - data   → son rapor; `nodes` varsa cihaz ↔ gateway eşleşmesi
 */
async function handleGatewayUplink(
  gatewayId: string,
  suffix: UplinkSuffix,
  json: unknown,
): Promise<void> {
  const parsed = gatewayUplinkSchema.safeParse(json);
  if (!parsed.success) {
    console.warn(`[mqtt] bilinmeyen gateway payload (${gatewayId}/${suffix})`);
    return;
  }
  const m = parsed.data;
  const now = new Date();
  const firmwareVersion = m.fw?.slice(0, 32) ?? null;

  const ownerId = (await getTenancy()).gatewayOwner.get(gatewayId);
  if (!ownerId) {
    noteDiscoveredGateway(gatewayId, { type: m.type ?? null, firmwareVersion }, now);
    return;
  }

  // LWT: bağlantı koptu. Son görülme ve son health ezilmez — panel "en son ne
  // zaman haber aldık"ı göstermeye devam eder.
  const lwt = m.online === false;
  const patch: Partial<typeof schema.gateways.$inferInsert> = lwt
    ? { online: false }
    : {
        lastSeen: now,
        online: true,
        ...(firmwareVersion ? { firmwareVersion } : {}),
        ...(suffix === "health"
          ? { health: m as Record<string, unknown>, healthAt: now }
          : { report: m as Record<string, unknown>, reportAt: now }),
      };
  await db.update(schema.gateways).set(patch).where(eq(schema.gateways.gatewayId, gatewayId));

  if (!lwt && suffix === "data") await syncGatewayNodes(gatewayId, ownerId, m);

  emitLiveEvent({
    kind: "gateway",
    gatewayId,
    customerId: ownerId,
    status: "ok",
    online: !lwt,
    firmwareVersion,
    at: now.toISOString(),
  });
}

/**
 * `nodes` listesi → `devices.gateway_id`. Yalnızca gateway'in müşterisine ait
 * cihazlar eşlenir (başka müşterinin cihazı listede olsa bile ona gateway
 * bilgisi yazılmaz). Liste yetkilidir: listede olmayan cihazın bu gateway'e
 * bağı kaldırılır (Thread cihazı başka border router'a geçmiş olabilir).
 */
async function syncGatewayNodes(gatewayId: string, ownerId: string, report: unknown) {
  const macs = nodeMacsFromReport(report);
  if (macs === null) return; // liste yok → bilgi yok, mevcut bağlar korunur
  const idx = peekTenancy();
  const own = macs.filter((mac) => idx?.deviceOwner.get(mac) === ownerId).sort();
  const sig = own.join(",");
  if (lastNodeSig.get(gatewayId) === sig) return;

  await db.transaction(async (tx) => {
    await tx
      .update(schema.devices)
      .set({ gatewayId: null })
      .where(
        own.length > 0
          ? and(
              eq(schema.devices.gatewayId, gatewayId),
              notInArray(schema.devices.deviceId, own),
            )
          : eq(schema.devices.gatewayId, gatewayId),
      );
    if (own.length > 0) {
      await tx
        .update(schema.devices)
        .set({ gatewayId })
        .where(inArray(schema.devices.deviceId, own));
    }
  });
  lastNodeSig.set(gatewayId, sig);
}

/** Gateway silinince/taşınınca bir sonraki raporda eşleşme yeniden yazılsın. */
export function forgetGatewayNodes(gatewayId: string): void {
  lastNodeSig.delete(gatewayId);
}

/** İlk kontrat (deviceId + brightness/relayStatus/channels): DB + bölge snapshot'ı + canlı event. */
async function handleLegacyData(mac: string, d: DataPayload): Promise<void> {
  const now = new Date();

  // 0) Çok-lamba ise kanallardan cihaz-seviyesi agregat türet (bölge snapshot'ı
  //    ve cihaz telemetri satırı için). channels yoksa top-level alanlar kullanılır.
  let aggBrightness = d.brightness;
  let aggIsOn = d.relayStatus ? d.relayStatus === "on" : undefined;
  if (d.channels && d.channels.length > 0) {
    const onCh = d.channels.filter((c) => c.relayStatus === "on");
    aggIsOn = onCh.length > 0;
    const withBr = onCh.filter((c) => typeof c.brightness === "number");
    aggBrightness = withBr.length
      ? Math.round(withBr.reduce((a, c) => a + (c.brightness ?? 0), 0) / withBr.length)
      : aggIsOn
        ? aggBrightness
        : 0;
  }
  const aggRelay = aggIsOn === undefined ? d.relayStatus : aggIsOn ? "on" : "off";

  // 1) Ham telemetriyi logla (cihaz-seviyesi agregat)
  await db.insert(schema.deviceStatus).values({
    deviceId: mac,
    brightness: aggBrightness,
    relayStatus: aggRelay,
    temperature: d.temperature,
    rssi: d.rssi,
    status: d.status,
  });

  // 1b) Çok-lamba: her kanalı fixtures'a upsert et + kanal başına canlı yayınla
  if (d.channels && d.channels.length > 0) {
    for (const c of d.channels) {
      const fxPatch: StatePatch & { status?: string; lastSeen?: Date } = {
        status: c.status === "error" ? "fault" : "ok",
        lastSeen: now,
      };
      if (c.relayStatus) fxPatch.isOn = c.relayStatus === "on";
      if (typeof c.brightness === "number") fxPatch.brightness = c.brightness;
      await upsertFixture(mac, c.ch, fxPatch);
      emitLiveEvent({
        deviceId: mac,
        channel: c.ch,
        isOn: c.relayStatus ? c.relayStatus === "on" : undefined,
        brightness: c.brightness,
        status: c.status ?? d.status,
        kind: "telemetry",
        at: now.toISOString(),
      });
    }
  }

  // 2) Cihazı bul, last_seen güncelle, bölgeyi çöz
  const { zone } = await touchDevice(mac, now);

  // 3) Bölge snapshot'ında YALNIZCA status (arıza) telemetriden güncellenir.
  //    Parlaklık/açık-kapalı alttan üste yayılmaz (bkz. handleD4i).
  if (zone) {
    await db
      .update(schema.zones)
      .set({ status: d.status === "error" ? "fault" : "ok" })
      .where(eq(schema.zones.id, zone.id));
  }

  // 4) Bekleyen komutları teslim edildi yap (device + bölge hedefi + all)
  await markDelivered(mac, zone, now);

  // 5) Dashboard'a canlı yayınla (cihaz-seviyesi agregat)
  emitLiveEvent({
    zoneSlug: zone?.slug,
    deviceId: mac,
    isOn: aggIsOn,
    brightness: aggBrightness,
    status: d.status,
    kind: "telemetry",
    at: now.toISOString(),
  });
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
 * ESP'ye giden komut payload'ı — minimal tutulur (LoRa'da binary olacak).
 *
 * `channel` YALNIZCA tek lamba hedeflendiğinde gönderilir (0-63). Toplu
 * komutta (tüm cihaz / bölge / tüm sistem) alan payload'a HİÇ konmaz;
 * cihaz alanın yokluğundan "tüm lambalar"ı anlar. Bir dönem bunun için
 * broadcast 255 gönderiliyordu — firmware artık reddediyor
 * ("bilinmeyen action"), bu yüzden 255 kaldırıldı.
 *
 * `text` yalnızca doluysa eklenir: alan hiç gönderilmediğinde cihaz son
 * ayarlanan Mors metnini tekrar çalar, boş string göndermek bunu bozardı.
 *
 * İSTİSNA: tüm hattı birlikte süren efektlerde (`allLamps`, örn. Chase)
 * `channel` HİÇ konmaz — broadcast 255 bile gönderilse cihaz
 * "chase efekti tum lambalari surer, channel gondermeyin" ile reddeder.
 */
function buildPayload({
  action,
  value,
  number,
  channel,
  text,
  id,
}: CommandInput & { id?: string }): string {
  const ch = wireChannel({ action, number, channel });

  const payload: CommandPayload = {
    action,
    ...(value != null ? { value } : {}),
    ...(number != null ? { number } : {}),
    ...(text ? { text } : {}),
    // `channel` YALNIZCA tek lamba hedeflenmişse konur. Toplu komutta (tüm
    // cihaz / bölge / tüm sistem) alan hiç gönderilmez — firmware broadcast
    // için 255'i kabul etmiyor, alanın yokluğunu bekliyor. Tüm hattı süren
    // efektler zaten kanal kabul etmez.
    ...(ch != null ? { channel: ch } : {}),
    // Cihaz yanıtında aynen geri gelir → hata doğru komuta bağlanır (handleAck).
    ...(id ? { id } : {}),
  };
  return JSON.stringify(payload);
}

/** Kabloya gidecek kanal: tüm hattı süren efektlerde yok (tüm lambalar). */
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
 *  - "zone"     → Meven:<slug>/cmd (id = slug) — tek publish, fanout yok
 *  - "customer" → müşterinin HER bölgesi için Meven:<slug>/cmd (id = müşteri
 *                 slug'ı, `zoneSlugs` = müşterinin bölgeleri). Müşterinin
 *                 "Tüm Sistem"i budur: firmware müşteri topic'i tanımadığı ve
 *                 Meven:all/cmd diğer müşterilerin cihazlarını da sürdüğü için
 *                 Kural #3'ün bilinçli istisnası (bölge sayısı kadar publish).
 *                 `zoneSlugs` tenancy index'inden gelir → DB beklenmez.
 *  - "all"      → Meven:all/cmd (id = "all") — TÜM müşteriler; yalnızca admin.
 */
// Publish anında (senkron, route handler'da ilk iş olarak) atanır — komutların
// gönderilme sırasını, arka plandaki recordCommand'ların bitiş sırasından
// bağımsız olarak korur. Frontend SSE'de bunu eski/yeni event ayrımı için kullanır.
let cmdSeq = 0;

export type CommandTarget = "device" | "zone" | "customer" | "all";

export function publishCommand(
  target: CommandTarget,
  id: string,
  cmd: CommandInput,
  zoneSlugs?: string[],
): { requestId: string; seq: number } {
  const topics =
    target === "device"
      ? [cmdTopic(id)]
      : target === "zone"
        ? [zoneCmdTopic(id)]
        : target === "customer"
          ? (zoneSlugs ?? []).map(zoneCmdTopic)
          : [ALL_CMD];

  // Komut id'si publish'ten ÖNCE üretilir: kablodaki `id` = commands.request_id.
  const requestId = randomUUID();
  // Tüm hedeflerde on/off → dim çevrilir (firmware on/off tanımıyor).
  const payload = buildPayload({ ...toWireCmd(cmd), id: requestId });
  const client = getMqttClient();
  for (const topic of topics) client.publish(topic, payload, { qos: 1 });
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
  getMqttClient().publish(cmdTopic(mac), JSON.stringify({ action, id: requestId }), { qos: 1 });
  rememberInflight(requestId, { maintenance: action });
  if (action === "ota_check") noteOtaSent(mac);
  return { requestId };
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
  // Tüm hattı süren efekt kabloda kanalsız gider (buildPayload) → cihazın
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
    await patchFixtures(
      macs.map((d) => d.mac),
      patchFor(action, value, number),
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
    await patchFixtures(idx.customersById.get(cid)?.macs ?? [], allPatch, at, seq);
  } else {
    customerIds = [...idx.customersById.keys()];
    updated = await db.update(schema.zones).set(allPatch).returning();
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
