import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getEnv } from "@/lib/env";
import { db, schema } from "@/lib/db";
import { emitLiveEvent } from "@/lib/events";
import { cmdTopic, ALL_CMD, DATA_WILDCARD } from "@/lib/topics";
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
  const mac = d.deviceId;
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
        at: now.toISOString(),
      });
    }
  }

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

    // 3) Bölge snapshot'ını cihaz-seviyesi agregata göre rafine et
    if (zone) {
      const patch: StatePatch & { status?: string } = {
        status: d.status === "error" ? "fault" : "ok",
      };
      if (typeof aggIsOn === "boolean") patch.isOn = aggIsOn;
      if (typeof aggBrightness === "number") patch.brightness = aggBrightness;
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

  // 5) Dashboard'a canlı yayınla (cihaz-seviyesi agregat)
  emitLiveEvent({
    zoneSlug,
    deviceId: mac,
    isOn: aggIsOn,
    brightness: aggBrightness,
    status: d.status,
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
 * Komut yayınla. target:
 *  - "device" → Meven:<MAC>/cmd (id = MAC). `channel` verilirse tek lamba, yoksa tüm cihaz.
 *  - "zone"   → bölgedeki her cihazın Meven:<MAC>/cmd'si (id = slug)
 *  - "all"    → Meven:all/cmd (id = "all")
 * commands tablosuna pending kaydeder; snapshot'ı (bölge/lamba) optimistic günceller.
 */
export async function publishCommand(
  target: "device" | "zone" | "all",
  id: string,
  action: Action,
  value?: number,
  number?: number,
  channel?: number,
): Promise<{ requestId: string }> {
  const requestId = randomUUID();
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

  const payload: CommandPayload = {
    action,
    ...(value != null ? { value } : {}),
    ...(number != null ? { number } : {}),
    ...(channel != null ? { channel } : {}),
  };
  const payloadStr = JSON.stringify(payload);
  const client = getMqttClient();

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
          at,
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
          at,
        });
      }
    }
    client.publish(cmdTopic(id), payloadStr, { qos: 1 });
  } else if (target === "zone") {
    const [zone] = await db
      .update(schema.zones)
      .set(patchFor(action, value, number))
      .where(eq(schema.zones.slug, id))
      .returning();
    if (zone) {
      emitLiveEvent({
        zoneSlug: zone.slug,
        isOn: zone.isOn,
        brightness: zone.brightness,
        activeFx: zone.activeFx,
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
    client.publish(ALL_CMD, payloadStr, { qos: 1 });
  }

  return { requestId };
}
