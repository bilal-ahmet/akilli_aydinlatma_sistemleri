import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import { cmdTopic, zoneCmdTopic, ALL_CMD, DATA_WILDCARD } from "@/lib/topics";
import {
  dataPayloadSchema,
  type Action,
  type CommandPayload,
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
    void handleData(topic, payload).catch((err) =>
      console.error("[mqtt] message handler error:", err),
    );
  });

  globalForMqtt.__fenerMqtt = client;
  return client;
}

/** Meven:<MAC>/data mesajını işle: DB'ye yaz + bölge snapshot'ı + canlı event. */
async function handleData(topic: string, raw: Buffer): Promise<void> {
  const parsed = dataPayloadSchema.safeParse(JSON.parse(raw.toString()));
  if (!parsed.success) {
    console.warn(`[mqtt] geçersiz data payload (${topic})`);
    return;
  }
  const d = parsed.data;
  const mac = d.deviceId;
  const now = new Date();

  // 1) Ham telemetriyi logla
  await db.insert(schema.deviceStatus).values({
    deviceId: mac,
    brightness: d.brightness,
    relayStatus: d.relayStatus,
    temperature: d.temperature,
    rssi: d.rssi,
    status: d.status,
  });

  // 2) Cihazı bul, last_seen güncelle, bölgeyi çöz
  const [device] = await db
    .update(schema.devices)
    .set({ lastSeen: now })
    .where(eq(schema.devices.deviceId, mac))
    .returning();

  let zoneSlug: string | undefined;
  if (device?.zoneId) {
    const [zone] = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.id, device.zoneId))
      .limit(1);
    zoneSlug = zone?.slug;

    // 3) Bölge snapshot'ını cihaz raporuna göre rafine et
    if (zone) {
      const patch: Partial<typeof schema.zones.$inferInsert> = {
        status: d.status === "error" ? "fault" : "ok",
      };
      if (d.relayStatus) patch.isOn = d.relayStatus === "on";
      if (typeof d.brightness === "number") patch.brightness = d.brightness;
      await db.update(schema.zones).set(patch).where(eq(schema.zones.id, zone.id));
    }
  }

  // 4) Bekleyen komutları teslim edildi yap (device + bölge hedefi + all)
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

  // 5) Dashboard'a canlı yayınla
  emitLiveEvent({
    zoneSlug,
    deviceId: mac,
    isOn: d.relayStatus ? d.relayStatus === "on" : undefined,
    brightness: d.brightness,
    status: d.status,
    at: now.toISOString(),
  });
}

/** ESP'ye giden komut payload'ı — minimal tutulur (LoRa'da binary olacak). */
function buildPayload(action: Action, value?: number, number?: number): string {
  const payload: CommandPayload = {
    action,
    ...(value != null ? { value } : {}),
    ...(number != null ? { number } : {}),
  };
  return JSON.stringify(payload);
}

/** Komut payload'ından bölge snapshot patch'i üretir. */
function patchFor(action: Action, value?: number, number?: number) {
  const patch: Partial<typeof schema.zones.$inferInsert> = {};
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

/**
 * Komutu MQTT'ye yayınla. SENKRON ve DB'ye dokunmaz — çağrıldığı anda, zaten
 * açık olan TLS bağlantısı üzerinden publish eder. DB yazımı ve SSE için
 * ayrıca recordCommand'ı çağır (bkz. route'lardaki `after()`); böylece Neon
 * round-trip'i komutun ESP'ye ulaşmasını geciktirmez.
 *
 * target:
 *  - "device" → Meven:<MAC>/cmd  (id = MAC)
 *  - "zone"   → Meven:<slug>/cmd (id = slug) — tek publish, fanout yok
 *  - "all"    → Meven:all/cmd    (id = "all")
 */
export function publishCommand(
  target: "device" | "zone" | "all",
  id: string,
  action: Action,
  value?: number,
  number?: number,
): { requestId: string } {
  const topic =
    target === "device" ? cmdTopic(id) : target === "zone" ? zoneCmdTopic(id) : ALL_CMD;

  getMqttClient().publish(topic, buildPayload(action, value, number), { qos: 1 });

  return { requestId: randomUUID() };
}

/**
 * publishCommand sonrası DB kaydı + bölge snapshot'ı + canlı event. Publish
 * yolundan çıkarıldığı için gecikmesi kullanıcıya yansımaz; route'lar bunu
 * `after()` içinde çağırır.
 */
export async function recordCommand(
  target: "device" | "zone" | "all",
  id: string,
  requestId: string,
  action: Action,
  value?: number,
  number?: number,
): Promise<void> {
  const at = new Date().toISOString();

  await db.insert(schema.commands).values({
    requestId,
    targetType: target,
    targetId: id,
    action,
    value: action === "efekt" ? number : value, // commands log
    status: "pending",
  });

  if (target === "device") return; // cihaz komutunda ek snapshot işi yok

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
      at,
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
      at,
    });
  }
}
