/*
 * Sanal ESP32 (mock device) — donanımsız test. ESP ekibinin Meven/MAC
 * kontratını birebir taklit eder:
 *   - subscribe Meven:<MAC>/cmd  ve  Meven:all/cmd
 *   - gelen { action, value, number, channel } komutunu uygular
 *   - Meven:<MAC>/data'ya durum yayınlar (tek-lamba veya çok-lamba channels[])
 *   - 30 sn'de bir heartbeat
 *
 * Çalıştır:
 *   npm run mock:device                       # tek lamba, varsayılan MAC A842E3123456
 *   npm run mock:device A8:42:E3:12:34:56      # iki noktalı da olur (normalize edilir)
 *   npm run mock:device A842E3123456 3         # 3 DALI kanallı (çok-lamba) cihaz
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { effectByNumber } from "@/lib/effects";

const MAC = (process.argv[2] ?? "A842E3123456")
  .replace(/[^0-9a-fA-F]/g, "")
  .toUpperCase();

// argv[3] > 0 ise çok-lamba (kanal) modu; kanallar 0..N-1.
const CH_COUNT = Math.max(0, Math.min(64, Number(process.argv[3] ?? 0) || 0));
const MULTI = CH_COUNT > 0;

const T_CMD = `Meven:${MAC}/cmd`;
const T_ALL = "Meven:all/cmd";
const T_DATA = `Meven:${MAC}/data`;

// Tek-lamba durumu (legacy)
let relayStatus: "on" | "off" = "off";
let brightness = 0;

// Çok-lamba durumu: kanal → { isOn, brightness }
const channels = new Map<number, { isOn: boolean; brightness: number }>();
if (MULTI) {
  for (let i = 0; i < CH_COUNT; i++) channels.set(i, { isOn: false, brightness: 0 });
}

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-${MAC}-${Math.random().toString(16).slice(2, 8)}`,
});

function publishData(status: "ok" | "error" = "ok") {
  const base = {
    deviceId: MAC,
    temperature: 38 + Math.floor(Math.random() * 8), // 38-45°C
    rssi: -50 - Math.floor(Math.random() * 30),
    status,
  };
  if (MULTI) {
    const chArr = [...channels.entries()].map(([ch, s]) => ({
      ch,
      brightness: s.isOn ? s.brightness : 0,
      relayStatus: s.isOn ? ("on" as const) : ("off" as const),
    }));
    client.publish(T_DATA, JSON.stringify({ ...base, channels: chArr }), { qos: 0 });
    console.log(`  → data: ${chArr.map((c) => `ch${c.ch}=${c.relayStatus}%${c.brightness}`).join(" ")} (${status})`);
  } else {
    const payload = { ...base, brightness: relayStatus === "on" ? brightness : 0, relayStatus };
    client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
    console.log(`  → data: röle=${relayStatus} %${payload.brightness} ${base.temperature}°C (${status})`);
  }
}

/** Tek kanal (veya çok-lamba modunda tüm kanallar) durumunu uygular. */
function applyToChannel(
  s: { isOn: boolean; brightness: number },
  action: string,
  value?: number,
) {
  if (action === "on") {
    s.isOn = true;
    if (s.brightness === 0) s.brightness = 100;
  } else if (action === "off") {
    s.isOn = false;
  } else if (action === "dim" && typeof value === "number") {
    s.brightness = value;
    s.isOn = true;
  }
}

client.on("connect", () => {
  console.log(`✓ HiveMQ bağlandı — sanal cihaz MAC: ${MAC}${MULTI ? ` (${CH_COUNT} kanal)` : ""}`);
  client.subscribe([T_CMD, T_ALL], { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor:\n    ${T_CMD}\n    ${T_ALL}`);
    console.log("\nDashboard'dan bu cihazı (veya lambalarını / bölgesini / 'Tüm Sistem'i) kullan → komutlar burada görünecek.\n");
    publishData();
  });
});

client.on("message", (topic, raw) => {
  let cmd: { action?: string; value?: number; number?: number; channel?: number };
  try {
    cmd = JSON.parse(raw.toString());
  } catch {
    console.warn("geçersiz komut payload");
    return publishData("error");
  }

  const via = topic === T_ALL ? "all" : "MAC";
  const action = cmd.action ?? "";
  const hasCh = typeof cmd.channel === "number";

  // Efekt — sadece logla, durumu değiştirme (firmware efekt motoru sürer).
  if (action === "efekt") {
    const fx = effectByNumber(cmd.number);
    const scope = hasCh ? `ch${cmd.channel}` : MULTI ? "tüm kanallar" : "cihaz";
    if (MULTI) {
      const list = hasCh ? [channels.get(cmd.channel!)!].filter(Boolean) : [...channels.values()];
      for (const s of list) s.isOn = true;
    } else {
      relayStatus = "on";
    }
    console.log(`◀ efekt (${via}, ${scope}): #${cmd.number} ${fx?.label ?? "?"}`);
    return publishData();
  }

  if (!["on", "off", "dim"].includes(action)) {
    console.warn(`bilinmeyen action: ${action}`);
    return publishData("error");
  }

  if (MULTI) {
    if (hasCh) {
      const s = channels.get(cmd.channel!);
      if (!s) {
        console.warn(`tanımsız kanal: ${cmd.channel}`);
        return publishData("error");
      }
      applyToChannel(s, action, cmd.value);
    } else {
      for (const s of channels.values()) applyToChannel(s, action, cmd.value);
    }
    console.log(`◀ komut (${via}, ${hasCh ? `ch${cmd.channel}` : "tüm kanallar"}): ${action}${cmd.value != null ? ` ${cmd.value}` : ""}`);
  } else {
    const s = { isOn: relayStatus === "on", brightness };
    applyToChannel(s, action, cmd.value);
    relayStatus = s.isOn ? "on" : "off";
    brightness = s.brightness;
    console.log(`◀ komut (${via}): ${action}${cmd.value != null ? ` ${cmd.value}` : ""}  →  röle=${relayStatus} brightness=${brightness}`);
  }
  publishData();
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

setInterval(() => publishData(), 30000);

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
