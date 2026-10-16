/*
 * Sanal gateway (mock) — donanımsız test. Gateway kontratını taklit eder
 * (firmware/GATEWAY-ENTEGRASYON.md):
 *   - Meven:<GW_ID>/health'e ~30 sn'de bir ortak zarf: { type, fw, uptime_s, online, uplink }
 *   - Meven:<GW_ID>/data'ya ~30 sn'de bir türe özgü blok + `nodes` (verilen MAC'ler)
 *   - LWT: Meven:<GW_ID>/health ← { type, online:false } (bağlantı koparsa broker yayınlar)
 *   - yalnızca kendi Meven:<GW_ID>/cmd topic'ine abone (all/ ve bölge topic'lerine DEĞİL)
 *
 * Çalıştır:
 *   npm run mock:gateway                                      # A1B2C3D4E5F6, thread_br, node yok
 *   npm run mock:gateway A1B2C3D4E5F6 thread_br A842E3123456  # node listesiyle
 *   npm run mock:gateway A1B2C3D4E5F6 cellular
 *
 * Ctrl+C bağlantıyı DISCONNECT göndermeden koparır → broker LWT'yi yayınlar,
 * panelde ağ geçidi anında "Bağlantı yok" olur.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { GATEWAY_TYPES, isGatewayType, type GatewayType } from "@/lib/gateways";

const GW_ID = (process.argv[2] ?? "A1B2C3D4E5F6").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
const TYPE_ARG = process.argv[3] ?? "thread_br";
if (!isGatewayType(TYPE_ARG)) {
  console.error(`Bilinmeyen tür: ${TYPE_ARG} (geçerli: ${GATEWAY_TYPES.join(", ")})`);
  process.exit(1);
}
const TYPE: GatewayType = TYPE_ARG;
const NODES = process.argv
  .slice(4)
  .map((m) => m.replace(/[^0-9a-fA-F]/g, "").toUpperCase())
  .filter((m) => /^[0-9A-F]{12}$/.test(m));

const T_CMD = `Meven:${GW_ID}/cmd`;
const T_DATA = `Meven:${GW_ID}/data`;
const T_HEALTH = `Meven:${GW_ID}/health`;
const bootAt = Date.now();

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-gw-${GW_ID}-${Math.random().toString(16).slice(2, 8)}`,
  will: {
    topic: T_HEALTH,
    payload: Buffer.from(JSON.stringify({ type: TYPE, online: false })),
    qos: 0,
    retain: false,
  },
});

/** Türe özgü örnek blok — gerçek gateway'in göndereceği alanların taslağı. */
function typeBlock(): Record<string, unknown> {
  switch (TYPE) {
    case "thread_br":
      return {
        thread: {
          role: "leader",
          network_name: "fener-1",
          channel: 15,
          pan_id: "0x1234",
          ext_pan_id: "dead00beef00cafe",
          router_count: 2,
          child_count: NODES.length,
        },
      };
    case "cellular":
      return { cellular: { operator: "Turkcell", network: "LTE", rssi: -71, rsrp: -98, iccid: "8990011234567890123" } };
    case "wifi":
      return { wifi: { ssid: "fener-saha", rssi: -58, clients: NODES.length } };
    case "lorawan":
      return { lorawan: { gateway_eui: "AA555A0000000101", frequency_plan: "EU868", rx_packets: 120, tx_packets: 40 } };
  }
}

function publishHealth() {
  const msg = {
    type: TYPE,
    fw: "0.1.0",
    uptime_s: Math.round((Date.now() - bootAt) / 1000),
    online: true,
    uplink: { kind: TYPE === "cellular" ? "cellular" : "ethernet", ip: "10.0.0.5" },
  };
  client.publish(T_HEALTH, JSON.stringify(msg), { qos: 0 });
  console.log(`→ ${T_HEALTH}`, JSON.stringify(msg));
}

function publishData() {
  const msg = {
    type: TYPE,
    ...typeBlock(),
    nodes: NODES.map((mac, i) => ({ mac, rssi: -60 - i * 4 })),
  };
  client.publish(T_DATA, JSON.stringify(msg), { qos: 0 });
  console.log(`→ ${T_DATA}`, JSON.stringify(msg));
}

client.on("connect", () => {
  console.log(`✓ Broker bağlandı — sanal gateway ${GW_ID} (${TYPE}), ${NODES.length} node`);
  client.subscribe(T_CMD, { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor: ${T_CMD}\n`);
    publishHealth();
    publishData();
  });
});

client.on("message", (topic, raw) => {
  console.log(`← ${topic}`, raw.toString());
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

setInterval(() => {
  publishHealth();
  publishData();
}, 30000);

process.on("SIGINT", () => {
  // DISCONNECT göndermeden kop: broker LWT'yi (online:false) yayınlasın.
  console.log("\nbağlantı koparılıyor (LWT tetiklenecek)…");
  client.stream.destroy();
  process.exit(0);
});
