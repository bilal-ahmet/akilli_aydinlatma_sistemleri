import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import {
  statusPayloadSchema,
  type Action,
  type CommandPayload,
} from "@/types/lighting";

/**
 * MQTT client singleton (HiveMQ Cloud, TLS). Tek uzun ömürlü Node process'te
 * yaşar; globalThis ile cache'lenir (HMR'da çift bağlantı olmasın).
 *
 * Akış:
 *  - subscribe city/lighting/device/+/status  → device_status'a yaz, event bus'a yayınla
 *  - publishCommand → commands'a pending yaz, ilgili topic'e QoS 1 publish
 */

const TOPIC = {
  zoneCommand: (slug: string) => `city/lighting/zone/${slug}/command`,
  deviceCommand: (id: string) => `city/lighting/device/${id}/command`,
  deviceStatusWildcard: "city/lighting/device/+/status",
};

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
    client.subscribe(TOPIC.deviceStatusWildcard, { qos: 0 }, (err) => {
      if (err) console.error("[mqtt] subscribe error:", err.message);
    });
  });

  client.on("error", (err) => console.error("[mqtt] error:", err.message));
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));

  client.on("message", (topic, payload) => {
    void handleStatusMessage(topic, payload).catch((err) =>
      console.error("[mqtt] message handler error:", err),
    );
  });

  globalForMqtt.__fenerMqtt = client;
  return client;
}

/** Status mesajını işle: DB'ye yaz + zone snapshot'ı güncelle + event yayınla. */
async function handleStatusMessage(topic: string, raw: Buffer): Promise<void> {
  const parsed = statusPayloadSchema.safeParse(JSON.parse(raw.toString()));
  if (!parsed.success) {
    console.warn(`[mqtt] geçersiz status payload (${topic})`);
    return;
  }
  const s = parsed.data;
  const now = new Date();

  // 1) Ham telemetriyi logla
  await db.insert(schema.deviceStatus).values({
    deviceId: s.deviceId,
    action: s.action,
    value: s.value,
    status: s.status,
    rssi: s.rssi,
  });

  // 2) Cihazı bul, last_seen güncelle, zone slug'ını çöz
  const [device] = await db
    .update(schema.devices)
    .set({ lastSeen: now })
    .where(eq(schema.devices.deviceId, s.deviceId))
    .returning();

  let zoneSlug: string | undefined;
  if (device?.zoneId) {
    const [zone] = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.id, device.zoneId))
      .limit(1);
    zoneSlug = zone?.slug;

    // 3) Zone durumunu cihaz raporuna göre rafine et
    if (zone) {
      await db
        .update(schema.zones)
        .set({ status: s.status === "error" ? "fault" : "ok" })
        .where(eq(schema.zones.id, zone.id));
    }
  }

  // 4) Bekleyen komutları teslim edildi olarak işaretle (device + zone hedefi)
  const targets = [s.deviceId, ...(zoneSlug ? [zoneSlug] : [])];
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
    deviceId: s.deviceId,
    action: s.action,
    value: s.value,
    isOn: s.action ? s.action !== "off" : undefined,
    brightness: s.action === "dim" ? s.value : undefined,
    status: s.status,
    at: now.toISOString(),
  });
}

/**
 * Komut yayınla: commands'a pending kaydet, optimistic zone snapshot güncelle,
 * ilgili MQTT topic'ine QoS 1 publish et. requestId ile idempotency.
 */
export async function publishCommand(
  targetType: "zone" | "device",
  targetId: string,
  action: Action,
  value?: number,
): Promise<{ requestId: string }> {
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();

  await db.insert(schema.commands).values({
    requestId,
    targetType,
    targetId,
    action,
    value,
    status: "pending",
  });

  // Optimistic: zone snapshot'ı hemen güncelle (ESP32 olmadan da dashboard yansısın)
  if (targetType === "zone") {
    const patch: Partial<typeof schema.zones.$inferInsert> = {};
    if (action === "on") patch.isOn = true;
    else if (action === "off") patch.isOn = false;
    else if (action === "dim") {
      patch.isOn = true;
      if (typeof value === "number") patch.brightness = value;
    }
    const [zone] = await db
      .update(schema.zones)
      .set(patch)
      .where(eq(schema.zones.slug, targetId))
      .returning();

    if (zone) {
      emitLiveEvent({
        zoneSlug: zone.slug,
        action,
        value,
        isOn: zone.isOn,
        brightness: zone.brightness,
        status: "ok",
        at: timestamp,
      });
    }
  }

  const topic =
    targetType === "zone"
      ? TOPIC.zoneCommand(targetId)
      : TOPIC.deviceCommand(targetId);

  const commandPayload: CommandPayload = {
    action,
    value,
    [targetType === "zone" ? "zoneId" : "deviceId"]: targetId,
    requestId,
    timestamp,
  };

  getMqttClient().publish(topic, JSON.stringify(commandPayload), { qos: 1 });

  return { requestId };
}
