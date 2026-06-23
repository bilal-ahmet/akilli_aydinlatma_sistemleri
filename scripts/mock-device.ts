/*
 * Sanal ESP32 (mock device) — donanımsız test.
 * HiveMQ Cloud'a bağlanır, gerçek ESP32 gibi davranır:
 *   - zone + device komut topic'lerine subscribe olur
 *   - gelen on/off/dim komutunu uygular (sadece loglar)
 *   - durumunu device status topic'ine publish eder
 *   - 30 sn'de bir heartbeat yollar
 *
 * Çalıştır:
 *   npm run mock:device                         # varsayılan ataturk-bulvari-001
 *   npm run mock:device esp-002 sahil-yolu      # özel deviceId + zoneId
 *
 * Dashboard'dan o zone'u aç/kapat → burada komut görünür, status geri gider,
 * dashboard SSE ile anında güncellenir.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";

const DEVICE_ID = process.argv[2] ?? "ataturk-bulvari-001";
const ZONE_ID = process.argv[3] ?? "ataturk-bulvari";

const T_ZONE_CMD = `city/lighting/zone/${ZONE_ID}/command`;
const T_DEVICE_CMD = `city/lighting/device/${DEVICE_ID}/command`;
const T_STATUS = `city/lighting/device/${DEVICE_ID}/status`;

let isOn = false;
let brightness = 0;

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `${DEVICE_ID}-mock-${Math.random().toString(16).slice(2, 8)}`,
});

function publishStatus(action: string, status: "ok" | "error" = "ok") {
  const payload = {
    deviceId: DEVICE_ID,
    zoneId: ZONE_ID,
    action,
    value: isOn ? brightness : 0,
    status,
    rssi: -50 - Math.floor(Math.random() * 30),
    timestamp: new Date().toISOString(),
  };
  client.publish(T_STATUS, JSON.stringify(payload), { qos: 0 });
  console.log(`  → status: ${action} value=${payload.value} (${status})`);
}

client.on("connect", () => {
  console.log(`✓ HiveMQ bağlandı — sanal cihaz: ${DEVICE_ID} (zone: ${ZONE_ID})`);
  client.subscribe([T_ZONE_CMD, T_DEVICE_CMD], { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor:\n    ${T_ZONE_CMD}\n    ${T_DEVICE_CMD}`);
    console.log("\nDashboard'dan bu zone'u aç/kapat/dim yap → komutlar burada görünecek.\n");
    publishStatus(isOn ? "on" : "off"); // ilk durum
  });
});

client.on("message", (topic, raw) => {
  let cmd: { action?: string; value?: number };
  try {
    cmd = JSON.parse(raw.toString());
  } catch {
    console.warn("geçersiz komut payload");
    return publishStatus("dim", "error");
  }

  const action = cmd.action ?? "";
  if (action === "on") {
    isOn = true;
    if (brightness === 0) brightness = 100;
  } else if (action === "off") {
    isOn = false;
  } else if (action === "dim") {
    if (typeof cmd.value === "number") {
      brightness = cmd.value;
      isOn = true;
    }
  } else {
    console.warn(`bilinmeyen action: ${action}`);
    return publishStatus("dim", "error");
  }

  console.log(`◀ komut: ${action}${cmd.value != null ? ` ${cmd.value}` : ""}  →  isOn=${isOn} brightness=${brightness}`);
  publishStatus(action);
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

// Heartbeat
setInterval(() => publishStatus(isOn ? "dim" : "off"), 30000);

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
