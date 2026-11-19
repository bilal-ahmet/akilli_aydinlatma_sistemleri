/*
 * Sanal ağ geçidi (Thread Border Router, binary protokol 0x03) — donanımsız
 * test. Firmware kontratını taklit eder (firmware/GATEWAY-ENTEGRASYON.md,
 * firmware/BR-BINARY-PROTOKOL.md):
 *   - Meven:<GW_ID>/bin ← BR_HEALTH: bağlanınca hemen (bir-kezlik alanlarla:
 *     IDF, derleme zamanı, aralıklar, ağ adı), sonra `--interval` sn'de bir
 *   - Meven:<GW_ID>/bin ← BR_NEIGHBORS (iki sayfa) + BR_ROUTES, aynı
 *     SNAPSHOT_ID ile; bağlanınca ve `--interval × 3` sn'de bir
 *   - Meven:<GW_ID>/lwt ← retained {"online":true}; MQTT will: {"online":false}
 *   - yalnızca kendi Meven:<GW_ID>/cmd topic'ine abone (all/ ve bölge DEĞİL);
 *     report_now / ota_check komutlarına COMMAND_ACK döner, report_now'da
 *     hemen rapor basar, ota_check'te OTA durumunu kısa süre "checking" yapar
 *
 * Çalıştır:
 *   npm run mock:gateway                                   # A1B2C3D4E5F6
 *   npm run mock:gateway 404CCA544698 --partition 305419896 --interval 30
 *   npm run mock:gateway 404CCA544698 --rlocs 5C01,6001    # komşu lamba RLOC16'ları
 *
 * Lamba bağı Thread partition eşleşmesiyle kurulur (lib/gatewayLink.ts):
 * `npm run mock:device <MAC> 2 --bin --partition 305419896 --rloc 0x5C01`.
 *
 * Ctrl+C bağlantıyı DISCONNECT göndermeden koparır → broker will'i
 * ({"online":false}, retained) yayınlar, panelde ağ geçidi anında "Bağlantı yok" olur.
 *
 * ⚠ Canlı broker'a basılan paket backend'de GERÇEK veri gibi işlenir.
 * Yerel olmayan bir MQTT_HOST'ta `--canli` bayrağı olmadan çalışmaz.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { decodeFrame, encodeFrame, toHex, type FieldValue } from "@/lib/binproto/codec";
import { BR_COMMAND_ACTIONS, BR_PROTOCOL_VERSION, type BrMessageTypeName } from "@/lib/binproto/brFields";

const RAW_ARGS = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--partition", "--interval", "--rlocs"]);
const ARGS = RAW_ARGS.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(RAW_ARGS[i - 1]));
function flag(name: string): string | undefined {
  const i = RAW_ARGS.indexOf(name);
  return i >= 0 ? RAW_ARGS[i + 1] : undefined;
}

const GW_ID = (ARGS[0] ?? "A1B2C3D4E5F6").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
if (!/^[0-9A-F]{12}$/.test(GW_ID)) {
  console.error(`Geçersiz GW_ID: ${ARGS[0]} (12 hane hex, "Meven:" öneki olmadan)`);
  process.exit(1);
}
const PARTITION = Number(flag("--partition") ?? 0x12345678);
const INTERVAL_S = Math.max(5, Number(flag("--interval") ?? 30) || 30);
const TOPOLOGY_INTERVAL_S = INTERVAL_S * 3;
/** Komşu lambaların RLOC16'ları (hex). İlki router, gerisi child. */
const NEIGHBOR_RLOCS = (flag("--rlocs") ?? "5C01,5C02,6000")
  .split(",")
  .map((s) => parseInt(s.replace(/^0x/i, ""), 16))
  .filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff);
const SELF_RLOC = 0x0400; // router 1 (leader)

const host = process.env.MQTT_HOST ?? "";
const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
if (!isLocal && !RAW_ARGS.includes("--canli")) {
  console.error(
    `MQTT_HOST=${host || "(boş)"} yerel değil. Canlı broker'a basılan paket backend'de gerçek veri ` +
      "gibi işlenir. Bilerek yapıyorsan --canli ekle.",
  );
  process.exit(1);
}

const T_CMD = `Meven:${GW_ID}/cmd`;
const T_BIN = `Meven:${GW_ID}/bin`;
const T_LWT = `Meven:${GW_ID}/lwt`;
const bootAt = Date.now();

const client = mqtt.connect({
  protocol: "mqtts",
  host,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-gw-${GW_ID}-${Math.random().toString(16).slice(2, 8)}`,
  will: { topic: T_LWT, payload: Buffer.from(JSON.stringify({ online: false })), qos: 1, retain: true },
});

type Fields = Array<readonly [string, FieldValue | null | undefined]>;

function publish(type: BrMessageTypeName, fields: Fields, label: string): void {
  const frame = encodeFrame(type, fields, { version: BR_PROTOCOL_VERSION });
  client.publish(T_BIN, Buffer.from(frame), { qos: 1 });
  console.log(`  → [bin ${frame.length} B] ${label}`);
}

let firstHealth = true;
let otaState = 0; // idle
let otaChecks = 0;
let mqttConnects = 0;
let snapshotId = Math.floor(Math.random() * 0xffff);

function publishHealth(): void {
  const uptime = Math.round((Date.now() - bootAt) / 1000);
  const r = (base: number, spread: number) => base + Math.floor(Math.random() * spread);
  const fields: Fields = [
    ["HEALTH_UPTIME_S", uptime],
    ["HEALTH_FREE_HEAP_BYTES", r(61_000, 2000)],
    ["HEALTH_MIN_FREE_HEAP_BYTES", 42_000],
    ["HEALTH_FIRMWARE_VERSION", 0x010200], // 1.2.0
    ["HEALTH_RESET_REASON", 1], // power_on
    ["HEALTH_MQTT_CONNECTS", mqttConnects],
    ["HEALTH_MQTT_PUBLISH_FAILS", 0],
    ["WIFI_CONNECTED", 1],
    ["WIFI_RSSI", -r(55, 8)],
    ["WIFI_CHANNEL", 6],
    ["WIFI_CONNECTED_S", uptime],
    ["WIFI_DISCONNECTS", 0],
    ["WIFI_BEACON_TIMEOUTS", 0],
    ["THREAD_ROLE", 4], // leader
    ["THREAD_RLOC16", SELF_RLOC],
    ["THREAD_PARTITION_ID", PARTITION],
    ["THREAD_CHANNEL", 15],
    ["THREAD_PAN_ID", 0x1234],
    ["THREAD_PARTITION_ID_CHANGES", 1],
    ["THREAD_ATTACH_ATTEMPTS", 1],
    ["LEADER_ROUTER_ID", 1],
    ["NETDATA_VERSION", 5],
    ["STABLE_NETDATA_VERSION", 3],
    ["ROUTER_COUNT", 2],
    ["CHILD_COUNT", Math.max(0, NEIGHBOR_RLOCS.length - 1)],
    ["NEIGHBOR_COUNT", NEIGHBOR_RLOCS.length],
    ["DETACHED_COUNT", 1],
    ["LEADER_COUNT", 1],
    ["BORDER_ROUTING_STATE", 3], // running
    ["BORDER_AGENT_ACTIVE", 1],
    ["CCA_FAILURE_RATE", r(500, 800)],
    ["COUNTERS_PERIOD_S", firstHealth ? uptime : INTERVAL_S],
    ["MAC_TX_TOTAL", r(180, 40)],
    ["MAC_TX_UNICAST", 150],
    ["MAC_TX_ACK_REQUESTED", 150],
    ["MAC_TX_ACKED", r(144, 6)],
    ["MAC_TX_RETRY", r(5, 10)],
    ["MAC_TX_ERR_CCA", r(0, 3)],
    ["MAC_TX_ERR_ABORT", 0],
    ["MAC_TX_ERR_BUSY_CHANNEL", 0],
    ["MAC_RX_TOTAL", r(380, 40)],
    ["MAC_RX_DUPLICATED", 1],
    ["MAC_RX_ERR_FCS", r(0, 4)],
    ["MAC_RX_ERR_SEC", 0],
    ["MAC_RX_ERR_NO_FRAME", 0],
    ["MAC_RX_ERR_UNKNOWN_NEIGHBOR", r(0, 5)],
    ["MAC_RX_ERR_OTHER", 0],
    ["IP_TX_SUCCESS", r(95, 10)],
    ["IP_TX_FAILURE", r(0, 2)],
    ["IP_RX_SUCCESS", r(170, 20)],
    ["IP_RX_FAILURE", 0],
    ["OTA_STATE", otaState],
    ["OTA_LAST_RESULT", 0], // up_to_date
    ["OTA_BUSY", otaState === 2 ? 1 : 0],
    ["OTA_CHECK_COUNT", otaChecks],
    ["OTA_LAST_CHECK_UPTIME_S", uptime],
    ["OTA_LAST_SUCCESS_UPTIME_S", 0],
  ];
  if (firstHealth) {
    // MQTT bağlantısı başına bir kez (bağlantıdan sonraki ilk health).
    fields.push(
      ["HEALTH_IDF_VERSION", 0x060000], // v6.0
      ["HEALTH_BUILD_TIMESTAMP", Math.floor(Date.UTC(2026, 10, 18, 9, 30, 0) / 1000)],
      ["HEALTH_INTERVAL_S", INTERVAL_S],
      ["HEALTH_TOPOLOGY_INTERVAL_S", TOPOLOGY_INTERVAL_S],
      ["THREAD_NETWORK_NAME", "Meven"],
    );
  }
  publish("BR_HEALTH", fields, `BR_HEALTH${firstHealth ? " (ilk, bir-kezlik alanlarla)" : ""} partition=${PARTITION}`);
  firstHealth = false;
}

/** Komşular iki sayfa (sayfa başına en fazla 2 kayıt), rotalar tek sayfa; aynı SNAPSHOT_ID. */
function publishTopology(): void {
  snapshotId = (snapshotId + 1) & 0xffff;
  const neighborRecord = (rloc: number, i: number): Fields => [
    ["NB_RLOC16", rloc],
    ["NB_EXT_ADDR", Uint8Array.from([0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f, (rloc >> 8) & 0xff, rloc & 0xff])],
    ["NB_IS_CHILD", i === 0 ? 0 : 1],
    ["NB_RSSI_AVG", -58 - i * 6],
    ["NB_RSSI_LAST", -60 - i * 6],
    ["NB_LINK_MARGIN", 38 - i * 6],
    ["NB_LQ_IN", 3],
    ...(i === 0 ? ([["NB_LQ_OUT", 3]] as Fields) : []),
    ["NB_AGE_S", 4 + i * 3],
    ["NB_FRAME_ERROR_RATE", 300 * i],
    ["NB_MESSAGE_ERROR_RATE", 0],
    ["NB_THREAD_VERSION", 4],
  ];
  const pages: number[][] = [];
  for (let i = 0; i < NEIGHBOR_RLOCS.length; i += 2) pages.push(NEIGHBOR_RLOCS.slice(i, i + 2));
  if (pages.length === 0) pages.push([]);
  let idx = 0;
  pages.forEach((page, p) => {
    const fields: Fields = [
      ["SNAPSHOT_ID", snapshotId],
      ["PAGE", p],
      ["TOTAL", NEIGHBOR_RLOCS.length],
      ...page.flatMap((rloc) => neighborRecord(rloc, idx++)),
      ["LAST_PAGE", p === pages.length - 1 ? 1 : 0],
    ];
    publish("BR_NEIGHBORS", fields, `BR_NEIGHBORS snapshot=${snapshotId} sayfa ${p + 1}/${pages.length}`);
  });

  const routerRloc = NEIGHBOR_RLOCS[0] ?? 0x0800;
  const routes: Fields = [
    ["SNAPSHOT_ID", snapshotId],
    ["PAGE", 0],
    ["TOTAL", 2],
    ...([
      ["RT_ROUTER_ID", SELF_RLOC >> 10],
      ["RT_RLOC16", SELF_RLOC],
      ["RT_NEXT_HOP", 63],
      ["RT_PATH_COST", 0],
      ["RT_LQ_IN", 0],
      ["RT_LQ_OUT", 0],
      ["RT_AGE_S", 0],
      ["RT_LINK_ESTABLISHED", 0],
      ["RT_ROUTER_ID", routerRloc >> 10],
      ["RT_RLOC16", routerRloc & 0xfc00],
      ["RT_NEXT_HOP", routerRloc >> 10],
      ["RT_PATH_COST", 1],
      ["RT_LQ_IN", 3],
      ["RT_LQ_OUT", 3],
      ["RT_AGE_S", 5],
      ["RT_LINK_ESTABLISHED", 1],
    ] as Fields),
    ["LAST_PAGE", 1],
  ];
  publish("BR_ROUTES", routes, `BR_ROUTES snapshot=${snapshotId}`);
}

function ack(action: number | undefined, id: number | undefined, result: number): void {
  publish(
    "COMMAND_ACK",
    [
      ["COMMAND_ACTION", action],
      ["COMMAND_ID", id],
      ["COMMAND_RESULT", result],
    ],
    `COMMAND_ACK action=${action === undefined ? "-" : (BR_COMMAND_ACTIONS[action] ?? action)} id=${id ?? "-"} sonuç=${result}`,
  );
}

client.on("connect", () => {
  mqttConnects += 1;
  firstHealth = true;
  console.log(`✓ Broker bağlandı — sanal ağ geçidi ${GW_ID} (thread_br, binary 0x03)`);
  client.publish(T_LWT, JSON.stringify({ online: true }), { qos: 1, retain: true });
  client.subscribe(T_CMD, { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor: ${T_CMD}\n`);
    publishHealth();
    publishTopology();
  });
});

client.on("message", (topic, raw) => {
  if (topic !== T_CMD) return;
  const frame = decodeFrame(raw);
  console.log(`← ${topic} ${toHex(raw)}`);
  if (!frame.ok) {
    // Firmware: bozuk komutta yalnızca COMMAND_RESULT döner.
    const code = frame.reason === "CRC" ? -15 : frame.reason === "VERSION" ? -16 : -17;
    return ack(undefined, undefined, code);
  }
  if (frame.version !== BR_PROTOCOL_VERSION) return ack(undefined, undefined, -16);
  const fields = new Map(frame.fields);
  const action = fields.get("COMMAND_ACTION") as number | undefined;
  const id = fields.get("COMMAND_ID") as number | undefined;
  if (action === undefined) return ack(undefined, id, -2);
  const name = BR_COMMAND_ACTIONS[action];
  if (name === "report_now") {
    ack(action, id, 0);
    publishHealth();
    publishTopology();
  } else if (name === "ota_check") {
    ack(action, id, 0);
    otaChecks += 1;
    otaState = 2; // checking
    publishHealth();
    setTimeout(() => {
      otaState = 0; // idle — güncel
      publishHealth();
    }, 4000);
  } else {
    ack(action, id, -5);
  }
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

setInterval(publishHealth, INTERVAL_S * 1000);
setInterval(publishTopology, TOPOLOGY_INTERVAL_S * 1000);

process.on("SIGINT", () => {
  // DISCONNECT göndermeden kop: broker will'i ({"online":false}) yayınlasın.
  console.log("\nbağlantı koparılıyor (LWT tetiklenecek)…");
  client.stream.destroy();
  process.exit(0);
});
