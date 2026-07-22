import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import {
  cmdTopic,
  zoneCmdTopic,
  macFromDataTopic,
  ALL_CMD,
  DATA_WILDCARD,
} from "@/lib/topics";
import {
  parseUplink,
  levelToPercent,
  flagToBool,
  d4iIsOn,
  d4iHasFault,
  BROADCAST_CHANNEL,
  type Action,
  type CommandAck,
  type CommandPayload,
  type D4iPeriodic,
  type DataPayload,
} from "@/types/lighting";

/**
 * MQTT client singleton (HiveMQ Cloud, TLS). Tek uzun ömürlü Node process'te
 * yaşar; globalThis ile cache'lenir (HMR'da çift bağlantı olmasın).
 *
 * Topic şeması (ESP ekibi kontratı, bkz. src/lib/topics.ts):
 *  - subscribe "+/data"         → Meven:<MAC>/data mesajlarını işle
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
    client.subscribe(DATA_WILDCARD, { qos: 0 }, (err) => {
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
 * Meven:<MAC>/data mesajını işle. Topic'te üç ayrı kontrat akıyor (bkz.
 * types/lighting.ts parseUplink):
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

  const uplink = parseUplink(json);
  if (!uplink) {
    console.warn(`[mqtt] bilinmeyen payload (${topic})`);
    return;
  }

  // Eski kontratta MAC payload'da, yenilerde yalnızca topic'te.
  const mac =
    uplink.kind === "legacy" ? uplink.data.deviceId : macFromDataTopic(topic);
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
  patch?: { lastError?: string | null; lastErrorAt?: Date | null },
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

/** Cihazdan haber gelince o cihaza/bölgesine ait bekleyen komutları kapat. */
async function markDelivered(mac: string, zoneSlug: string | undefined, now: Date) {
  const targets = [mac, "all", ...(zoneSlug ? [zoneSlug] : [])];
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

  // 3) Kanal seviyesinde canlı yayın
  emitLiveEvent({
    deviceId: mac,
    channel: ch,
    isOn,
    brightness,
    status: fault ? "error" : "ok",
    kind: "telemetry",
    at: now.toISOString(),
  });

  // 4) Cihaz-seviyesi agregat: cihazın tüm lambalarının güncel satırları
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

  // 5) Bölge snapshot'ı + bekleyen komutlar + cihaz seviyesi canlı yayın
  const { zone } = await touchDevice(mac, now);
  if (zone) {
    await db
      .update(schema.zones)
      .set({ isOn: aggIsOn, brightness: aggBrightness, status: aggFault ? "fault" : "ok" })
      .where(eq(schema.zones.id, zone.id));
  }
  await markDelivered(mac, zone?.slug, now);

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
 * Payload'da korelasyon alanı yok — hata, o cihaza (ya da bölgesine) giden EN
 * SON bekleyen komuta yazılır ve `devices.last_error`'da rozet için saklanır.
 * Olaya bilerek `zoneSlug` konmaz: geçici bir komut hatası bölgeyi arızalı
 * göstermemeli (bölge durumu telemetriden gelir).
 */
async function handleAck(mac: string, ack: CommandAck): Promise<void> {
  const now = new Date();
  const at = now.toISOString();

  if (ack.status === "ok") {
    const { zone } = await touchDevice(mac, now, { lastError: null, lastErrorAt: null });
    await markDelivered(mac, zone?.slug, now);
    emitLiveEvent({ deviceId: mac, status: "ok", kind: "ack", at });
    return;
  }

  const message = (ack.error ?? "cihaz komutu işleyemedi").slice(0, 200);
  console.warn(`[mqtt] komut hatası (${mac}): ${message}`);

  const { zone } = await touchDevice(mac, now, { lastError: message, lastErrorAt: now });
  const targets = [mac, "all", ...(zone ? [zone.slug] : [])];
  const [latest] = await db
    .select({ id: schema.commands.id })
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

  emitLiveEvent({ deviceId: mac, status: "error", error: message, kind: "ack", at });
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

  // 3) Bölge snapshot'ını cihaz-seviyesi agregata göre rafine et
  if (zone) {
    const patch: StatePatch & { status?: string } = {
      status: d.status === "error" ? "fault" : "ok",
    };
    if (typeof aggIsOn === "boolean") patch.isOn = aggIsOn;
    if (typeof aggBrightness === "number") patch.brightness = aggBrightness;
    await db.update(schema.zones).set(patch).where(eq(schema.zones.id, zone.id));
  }

  // 4) Bekleyen komutları teslim edildi yap (device + bölge hedefi + all)
  await markDelivered(mac, zone?.slug, now);

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
 * ESP'ye giden komut payload'ı — minimal tutulur (LoRa'da binary olacak).
 *
 * `channel` HER komutta gönderilir: firmware `dim` ve `efekt` için zorunlu
 * tutuyor ("... ve channel (0..63 veya 255) gerekli"). Tek lamba hedefi yoksa
 * DALI broadcast adresi (255) yazılır — API kontratında `channel` yokluğu
 * "tüm cihaz" demeye devam eder, çeviri yalnızca burada yapılır.
 */
function buildPayload(action: Action, value?: number, number?: number, channel?: number): string {
  const payload: CommandPayload = {
    action,
    ...(value != null ? { value } : {}),
    ...(number != null ? { number } : {}),
    channel: channel ?? BROADCAST_CHANNEL,
  };
  return JSON.stringify(payload);
}

/**
 * Komutu MQTT'ye yayınla. SENKRON ve DB'ye dokunmaz — çağrıldığı anda, zaten
 * açık olan TLS bağlantısı üzerinden publish eder. DB yazımı ve SSE için
 * ayrıca recordCommand'ı çağır (bkz. route'lardaki `after()`); böylece Neon
 * round-trip'i komutun ESP'ye ulaşmasını geciktirmez.
 *
 * target:
 *  - "device" → Meven:<MAC>/cmd  (id = MAC). `channel` verilirse tek lamba, yoksa tüm cihaz.
 *  - "zone"   → Meven:<slug>/cmd (id = slug) — tek publish, fanout yok
 *  - "all"    → Meven:all/cmd    (id = "all")
 */
// Publish anında (senkron, route handler'da ilk iş olarak) atanır — komutların
// gönderilme sırasını, arka plandaki recordCommand'ların bitiş sırasından
// bağımsız olarak korur. Frontend SSE'de bunu eski/yeni event ayrımı için kullanır.
let cmdSeq = 0;

export function publishCommand(
  target: "device" | "zone" | "all",
  id: string,
  action: Action,
  value?: number,
  number?: number,
  channel?: number,
): { requestId: string; seq: number } {
  const topic =
    target === "device" ? cmdTopic(id) : target === "zone" ? zoneCmdTopic(id) : ALL_CMD;

  getMqttClient().publish(topic, buildPayload(action, value, number, channel), { qos: 1 });

  return { requestId: randomUUID(), seq: ++cmdSeq };
}

/**
 * publishCommand sonrası DB kaydı + snapshot (bölge veya lamba) + canlı event.
 * Publish yolundan çıkarıldığı için gecikmesi kullanıcıya yansımaz; route'lar
 * bunu `after()` içinde çağırır.
 */
export async function recordCommand(
  target: "device" | "zone" | "all",
  id: string,
  requestId: string,
  seq: number,
  action: Action,
  value?: number,
  number?: number,
  channel?: number,
): Promise<void> {
  const at = new Date().toISOString();

  await db.insert(schema.commands).values({
    requestId,
    targetType: target,
    targetId: id,
    channel: channel ?? null,
    action,
    value: action === "efekt" ? number : value, // commands log
    status: "pending",
  });

  if (target === "device") {
    // Optimistic lamba snapshot'ı: tek kanal ya da cihazın tüm bilinen lambaları.
    const patch = patchFor(action, value, number);
    if (channel != null) {
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

  // all
  const updated = await db
    .update(schema.zones)
    .set(patchFor(action, value, number))
    .returning();
  for (const z of updated) {
    emitLiveEvent({
      zoneSlug: z.slug,
      isOn: z.isOn,
      brightness: z.brightness,
      activeFx: z.activeFx,
      status: "ok",
      kind: "command",
      at,
      seq,
    });
  }
}
