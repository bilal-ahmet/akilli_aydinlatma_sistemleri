/*
 * Sanal ESP32 (mock device) — donanımsız test. ESP ekibinin Meven/MAC
 * kontratını birebir taklit eder:
 *   - subscribe Meven:<MAC>/cmd  ve  Meven:all/cmd
 *   - gelen { action, value } komutunu uygular
 *   - Meven:<MAC>/data'ya { deviceId, brightness, relayStatus, temperature, rssi, status } yayınlar
 *   - 30 sn'de bir heartbeat
 *
 * Çalıştır:
 *   npm run mock:device                       # varsayılan MAC A842E3123456
 *   npm run mock:device A8:42:E3:12:34:56      # iki noktalı da olur (normalize edilir)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";

const MAC = (process.argv[2] ?? "A842E3123456")
  .replace(/[^0-9a-fA-F]/g, "")
  .toUpperCase();

const T_CMD = `Meven:${MAC}/cmd`;
const T_ALL = "Meven:all/cmd";
const T_DATA = `Meven:${MAC}/data`;

let relayStatus: "on" | "off" = "off";
let brightness = 0;

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
  const payload = {
    deviceId: MAC,
    brightness: relayStatus === "on" ? brightness : 0,
    relayStatus,
    temperature: 38 + Math.floor(Math.random() * 8), // 38-45°C
    rssi: -50 - Math.floor(Math.random() * 30),
    status,
  };
  client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
  console.log(`  → data: röle=${relayStatus} %${payload.brightness} ${payload.temperature}°C (${status})`);
}

client.on("connect", () => {
  console.log(`✓ HiveMQ bağlandı — sanal cihaz MAC: ${MAC}`);
  client.subscribe([T_CMD, T_ALL], { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor:\n    ${T_CMD}\n    ${T_ALL}`);
    console.log("\nDashboard'dan bu cihazın bölgesini ya da 'Tüm Sistem'i kullan → komutlar burada görünecek.\n");
    publishData();
  });
});

client.on("message", (topic, raw) => {
  let cmd: { action?: string; value?: number };
  try {
    cmd = JSON.parse(raw.toString());
  } catch {
    console.warn("geçersiz komut payload");
    return publishData("error");
  }

  const action = cmd.action ?? "";
  if (action === "on") {
    relayStatus = "on";
    if (brightness === 0) brightness = 100;
  } else if (action === "off") {
    relayStatus = "off";
  } else if (action === "dim") {
    if (typeof cmd.value === "number") {
      brightness = cmd.value;
      relayStatus = "on";
    }
  } else {
    console.warn(`bilinmeyen action: ${action}`);
    return publishData("error");
  }

  const via = topic === T_ALL ? "all" : "MAC";
  console.log(`◀ komut (${via}): ${action}${cmd.value != null ? ` ${cmd.value}` : ""}  →  röle=${relayStatus} brightness=${brightness}`);
  publishData();
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

setInterval(() => publishData(), 30000);

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
