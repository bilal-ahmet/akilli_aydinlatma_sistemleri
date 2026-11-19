/**
 * Binary MQTT protokolü — Thread Border Router (paket sürümü 0x03): alan
 * tablosu ve değer enum'ları.
 *
 * SÖZLEŞMENİN KAYNAĞI firmware reposundaki Border Router codec'i:
 * `components/br_codec/include/msg_fields.h` (kodlar) ve
 * `components/br_codec/src/msg_fields.c` (boylar). Bu dosya onun TypeScript
 * kopyasıdır — kaynak: firmware ekibinin cevabı, `firmware/BR-BINARY-PROTOKOL.md`.
 *
 * Lamba protokolüyle (0x01, `fields.ts`) aynı çerçeve, CRC ve değer
 * kodlaması; ALAN TABLOSU AYRIDIR (0x02-0x05, 0x10-0x16, 0x20-0x2A… lambada
 * başka anlam taşır). Paketin ilk baytı hangi tablonun okunacağını söyler.
 * Ortak anlamlı alanlar aynı koddadır: TYPE 0x01, komut 0xA0/0xA1/0xA6,
 * health 0xB0-0xBA, thread 0xC0-0xCD, OTA 0xE0-0xEB.
 *
 * ⚠ KURAL (Kural #19): firmware yeni bir alan eklediğinde ÖNCE bu tablo
 * güncellenip deploy edilir, SONRA ağ geçitlerine OTA yapılır. Tanımsız alan
 * kodu taşıyan paket tamamen reddedilir (ağ geçidi panelde görünmez; admin
 * kartında kırmızı uyarı çıkar). Mevcut bir kodun boyu/anlamı asla değişmez.
 *
 * Saf modül: sunucu, istemci ve tsx betikleri kullanabilir.
 */
import type { EnumTable, FieldDef } from "./fields";

export const BR_PROTOCOL_VERSION = 0x03;

const u8 = (code: number, name: string): FieldDef => ({ code, name, size: 1, kind: "u8" });
const i8 = (code: number, name: string): FieldDef => ({ code, name, size: 1, kind: "i8" });
const u16 = (code: number, name: string): FieldDef => ({ code, name, size: 2, kind: "u16" });
const u24 = (code: number, name: string): FieldDef => ({ code, name, size: 3, kind: "u24" });
const u32 = (code: number, name: string): FieldDef => ({ code, name, size: 4, kind: "u32" });
const i32 = (code: number, name: string): FieldDef => ({ code, name, size: 4, kind: "i32" });

export const BR_FIELD_DEFS: readonly FieldDef[] = [
  // Ortak ve sayfalama
  u8(0x01, "TYPE"),
  u16(0x02, "SNAPSHOT_ID"),
  u8(0x03, "PAGE"),
  u8(0x04, "LAST_PAGE"),
  u8(0x05, "TOTAL"),
  // Wi-Fi (gateway'in internete çıkışı)
  u8(0x10, "WIFI_CONNECTED"),
  i8(0x11, "WIFI_RSSI"),
  u8(0x12, "WIFI_CHANNEL"),
  u32(0x13, "WIFI_DISCONNECTS"),
  u8(0x14, "WIFI_LAST_DISCONNECT_REASON"),
  u32(0x15, "WIFI_BEACON_TIMEOUTS"),
  u32(0x16, "WIFI_CONNECTED_S"),
  // Thread ağı (leader gözüyle)
  u8(0x20, "LEADER_ROUTER_ID"),
  u8(0x21, "ROUTER_COUNT"),
  u8(0x22, "CHILD_COUNT"),
  u8(0x23, "NEIGHBOR_COUNT"),
  u8(0x24, "NETDATA_VERSION"),
  u8(0x25, "STABLE_NETDATA_VERSION"),
  u16(0x26, "DETACHED_COUNT"),
  u16(0x27, "LEADER_COUNT"),
  u8(0x28, "BORDER_ROUTING_STATE"),
  u8(0x29, "BORDER_AGENT_ACTIVE"),
  u16(0x2a, "CCA_FAILURE_RATE"),
  // Sayaçlar: son başarılı BR_HEALTH'ten bu yana FARK (açılıştan sonraki ilk
  // paket açılıştan beri toplamı taşır).
  u32(0x30, "MAC_TX_TOTAL"),
  u32(0x31, "MAC_TX_UNICAST"),
  u32(0x32, "MAC_TX_ACK_REQUESTED"),
  u32(0x33, "MAC_TX_ACKED"),
  u32(0x34, "MAC_TX_RETRY"),
  u32(0x35, "MAC_TX_ERR_CCA"),
  u32(0x36, "MAC_TX_ERR_ABORT"),
  u32(0x37, "MAC_TX_ERR_BUSY_CHANNEL"),
  u32(0x38, "MAC_RX_TOTAL"),
  u32(0x39, "MAC_RX_DUPLICATED"),
  u32(0x3a, "MAC_RX_ERR_FCS"),
  u32(0x3b, "MAC_RX_ERR_SEC"),
  u32(0x3c, "MAC_RX_ERR_NO_FRAME"),
  u32(0x3d, "MAC_RX_ERR_UNKNOWN_NEIGHBOR"),
  u32(0x3e, "MAC_RX_ERR_OTHER"),
  u32(0x3f, "COUNTERS_PERIOD_S"),
  u32(0x40, "IP_TX_SUCCESS"),
  u32(0x41, "IP_TX_FAILURE"),
  u32(0x42, "IP_RX_SUCCESS"),
  u32(0x43, "IP_RX_FAILURE"),
  // Komşu kaydı (BR_NEIGHBORS) — her NB_RLOC16 yeni kayıt başlatır.
  u16(0x60, "NB_RLOC16"),
  { code: 0x61, name: "NB_EXT_ADDR", size: 0, kind: "bytes" },
  u8(0x62, "NB_IS_CHILD"),
  i8(0x63, "NB_RSSI_AVG"),
  i8(0x64, "NB_RSSI_LAST"),
  u8(0x65, "NB_LINK_MARGIN"),
  u8(0x66, "NB_LQ_IN"),
  u8(0x67, "NB_LQ_OUT"),
  u16(0x68, "NB_AGE_S"),
  u16(0x69, "NB_FRAME_ERROR_RATE"),
  u16(0x6a, "NB_MESSAGE_ERROR_RATE"),
  u8(0x6b, "NB_THREAD_VERSION"),
  // Router kaydı (BR_ROUTES) — her RT_ROUTER_ID yeni kayıt başlatır.
  u8(0x70, "RT_ROUTER_ID"),
  u16(0x71, "RT_RLOC16"),
  u8(0x72, "RT_NEXT_HOP"),
  u8(0x73, "RT_PATH_COST"),
  u8(0x74, "RT_LQ_IN"),
  u8(0x75, "RT_LQ_OUT"),
  u8(0x76, "RT_AGE_S"),
  u8(0x77, "RT_LINK_ESTABLISHED"),
  // Komut ve ack
  u8(0xa0, "COMMAND_ACTION"),
  u16(0xa1, "COMMAND_ID"),
  i8(0xa6, "COMMAND_RESULT"),
  // Health
  u32(0xb0, "HEALTH_UPTIME_S"),
  u32(0xb1, "HEALTH_FREE_HEAP_BYTES"),
  u24(0xb2, "HEALTH_FIRMWARE_VERSION"),
  u24(0xb3, "HEALTH_IDF_VERSION"),
  u32(0xb4, "HEALTH_BUILD_TIMESTAMP"),
  u32(0xb5, "HEALTH_MIN_FREE_HEAP_BYTES"),
  u8(0xb6, "HEALTH_RESET_REASON"),
  u16(0xb7, "HEALTH_MQTT_CONNECTS"),
  u32(0xb8, "HEALTH_MQTT_PUBLISH_FAILS"),
  u32(0xb9, "HEALTH_INTERVAL_S"),
  u32(0xba, "HEALTH_TOPOLOGY_INTERVAL_S"),
  // Gateway'in Thread durumu
  u8(0xc0, "THREAD_ROLE"),
  u16(0xc6, "THREAD_RLOC16"),
  u32(0xc7, "THREAD_PARTITION_ID"),
  u8(0xc8, "THREAD_CHANNEL"),
  u16(0xc9, "THREAD_PAN_ID"),
  { code: 0xca, name: "THREAD_NETWORK_NAME", size: 0, kind: "text" },
  u16(0xcc, "THREAD_PARTITION_ID_CHANGES"),
  u16(0xcd, "THREAD_ATTACH_ATTEMPTS"),
  // OTA (lambayla aynı enum'lar)
  u8(0xe0, "OTA_STATE"),
  u8(0xe1, "OTA_LAST_RESULT"),
  u8(0xe2, "OTA_BUSY"),
  u32(0xe3, "OTA_CHECK_COUNT"),
  u32(0xe4, "OTA_LAST_CHECK_UPTIME_S"),
  u32(0xe5, "OTA_LAST_SUCCESS_UPTIME_S"),
  u24(0xe6, "OTA_LAST_TARGET_VERSION"),
  i32(0xeb, "OTA_LAST_ERROR"),
];

export const BR_FIELDS_BY_CODE: ReadonlyMap<number, FieldDef> = new Map(
  BR_FIELD_DEFS.map((f) => [f.code, f]),
);
export const BR_FIELDS_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(
  BR_FIELD_DEFS.map((f) => [f.name, f]),
);

/** TYPE değerleri. BR'de `hello` ve `data` tipi yok. */
export const BR_MESSAGE_TYPES = {
  BR_HEALTH: 5,
  COMMAND_ACK: 6,
  COMMAND: 8,
  BR_NEIGHBORS: 9,
  BR_ROUTES: 10,
} as const;
export type BrMessageTypeName = keyof typeof BR_MESSAGE_TYPES;

export const BR_MESSAGE_TYPE_NAMES: EnumTable = Object.fromEntries(
  Object.entries(BR_MESSAGE_TYPES).map(([name, code]) => [code, name]),
);

/** Gateway komutları (COMMAND_ACTION). */
export const BR_COMMAND_ACTIONS: EnumTable = {
  5: "ota_check",
  6: "report_now",
};
export const BR_COMMAND_ACTION_LIST = ["report_now", "ota_check"] as const;
export type BrCommandAction = (typeof BR_COMMAND_ACTION_LIST)[number];

/** COMMAND_RESULT → ack'in hata metni (ASCII, firmware'in anlamıyla). 0 = ok. */
export const BR_COMMAND_RESULT_TEXTS: EnumTable = {
  [-2]: "action alani yok",
  [-5]: "bilinmeyen action",
  [-12]: "ota servisi henuz hazir degil",
  [-15]: "crc hatali, paket islenmedi",
  [-16]: "desteklenmeyen protokol versiyonu",
  [-17]: "paket bicimi bozuk",
};

/** BORDER_ROUTING_STATE (otBorderRoutingState). */
export const BORDER_ROUTING_STATES: EnumTable = {
  0: "uninitialized",
  1: "disabled",
  2: "stopped",
  3: "running",
};

/** RT_NEXT_HOP'ta "yol yok / gateway'in kendisi". */
export const BR_NO_NEXT_HOP = 63;
/** u16 oranlar (CCA, çerçeve/mesaj hata oranı): 0xFFFF = %100. */
export const BR_RATE_FULL = 0xffff;
