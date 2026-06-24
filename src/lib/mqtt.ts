import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import { cmdTopic, ALL_CMD, DATA_WILDCARD, macFromDataTopic } from "@/lib/topics";
import { normalizeMac } from "@/lib/mac";
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
 *  - subscribe "+/data"        → Meven:<MAC>/data mesajlarını işle
 *  - publish   Meven:<MAC>/cmd → tekil/bölge komutu
 *  - publish   Meven:all/cmd   → toplu komut
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
  // MAC topic'ten okunur (payload'da deviceId opsiyonel). Fallback: payload.
  const mac = normalizeMac(macFromDataTopic(topic) ?? d.deviceId ?? "");
  if (!mac) {
    console.warn(`[mqtt] MAC çözülemedi (${topic})`);
    return;
  }
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

/** Komut payload'ından bölge snapshot patch'i üretir. */
function patchFor(action: Action, value?: number) {
  const patch: Partial<typeof schema.zones.$inferInsert> = {};
  if (action === "on") patch.isOn = true;
  else if (action === "off") patch.isOn = false;
  else if (action === "dim") {
    patch.isOn = true;
    if (typeof value === "number") patch.brightness = value;
  }
  return patch;
}

/**
 * Komut yayınla. target:
 *  - "device" → Meven:<MAC>/cmd (id = MAC)
 *  - "zone"   → bölgedeki her cihazın Meven:<MAC>/cmd'si (id = slug)
 *  - "all"    → Meven:all/cmd (id = "all")
 * commands tablosuna pending kaydeder; bölge/all'da snapshot'ı optimistic günceller.
 */
export async function publishCommand(
  target: "device" | "zone" | "all",
  id: string,
  action: Action,
  value?: number,
): Promise<{ requestId: string }> {
  const requestId = randomUUID();
  const at = new Date().toISOString();

  await db.insert(schema.commands).values({
    requestId,
    targetType: target,
    targetId: id,
    action,
    value,
    status: "pending",
  });

  const payload: CommandPayload = { action, ...(value != null ? { value } : {}) };
  const payloadStr = JSON.stringify(payload);
  const client = getMqttClient();

  if (target === "device") {
    client.publish(cmdTopic(id), payloadStr, { qos: 1 });
  } else if (target === "zone") {
    const [zone] = await db
      .update(schema.zones)
      .set(patchFor(action, value))
      .where(eq(schema.zones.slug, id))
      .returning();
    if (zone) {
      emitLiveEvent({
        zoneSlug: zone.slug,
        isOn: zone.isOn,
        brightness: zone.brightness,
        status: "ok",
        at,
      });
      const devs = await db
        .select({ deviceId: schema.devices.deviceId })
        .from(schema.devices)
        .where(eq(schema.devices.zoneId, zone.id));
      for (const dev of devs) {
        client.publish(cmdTopic(dev.deviceId), payloadStr, { qos: 1 });
      }
    }
  } else {
    // all
    const updated = await db
      .update(schema.zones)
      .set(patchFor(action, value))
      .returning();
    for (const z of updated) {
      emitLiveEvent({
        zoneSlug: z.slug,
        isOn: z.isOn,
        brightness: z.brightness,
        status: "ok",
        at,
      });
    }
    client.publish(ALL_CMD, payloadStr, { qos: 1 });
  }

  return { requestId };
}
