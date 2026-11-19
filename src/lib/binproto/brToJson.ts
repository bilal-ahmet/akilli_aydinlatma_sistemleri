/**
 * Çözülmüş Border Router paketi (sürüm 0x03) → backend'in sakladığı JSON.
 *
 * Lamba tarafındaki `toJson.ts`'ten farkı: burada taklit edilecek eski bir
 * JSON kontratı yok. Çıktı doğrudan `gateways.health` / `gateways.report`
 * sütunlarına yazılır ve `lib/gateways.ts → summarizeGateway` tarafından
 * okunur. Alan adları snake_case, birimler addadır (`_s`, `_dbm`, `_pct`).
 *
 * Belgeye göre codec düzeyinde zorunlu tek alan TYPE'tır; eksik alan `null`
 * olur, paket reddedilmez. Saf modül.
 */
import type { DecodedFrame, FieldEntry, FieldValue } from "./codec";
import { espErrToName } from "./espErr";
import { OTA_RESULTS, OTA_STATES, RESET_REASONS, THREAD_ROLES, type EnumTable } from "./fields";
import {
  BORDER_ROUTING_STATES,
  BR_COMMAND_ACTIONS,
  BR_COMMAND_RESULT_TEXTS,
  BR_NO_NEXT_HOP,
  BR_RATE_FULL,
} from "./brFields";
import { buildDateTime, versionText, type ConvertContext } from "./toJson";

type Json = Record<string, unknown>;
type Fields = Map<string, FieldValue>;

function num(fields: Fields, name: string): number | null {
  const v = fields.get(name);
  return typeof v === "number" ? v : null;
}

function bool(fields: Fields, name: string): boolean | null {
  const v = num(fields, name);
  return v === null ? null : v !== 0;
}

function enumName(table: EnumTable, value: number | null, ctx: ConvertContext, label: string): string | null {
  if (value === null) return null;
  const name = table[value];
  if (name !== undefined) return name;
  ctx.warnings.push(`bilinmeyen ${label} değeri ${value}`);
  return "unknown";
}

/** u16 oran (0xFFFF = %100) → yüzde, bir ondalık. */
function ratePct(value: number | null): number | null {
  if (value === null) return null;
  return Math.round((value / BR_RATE_FULL) * 1000) / 10;
}

const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");

// ── Health ───────────────────────────────────────────────────

/**
 * MQTT bağlantısı başına bir kez gelen alanlar (B3, B4, B9, BA, CA). Gateway
 * başına bellekte tutulur; paketteki değer önbelleğe yazılır (yerinde
 * güncellenir), JSON her seferinde buradan doldurulur.
 */
export interface BrBuildInfo {
  idf_version?: string;
  build_date?: string;
  build_time?: string;
  network_name?: string;
  health_interval_s?: number;
  topology_interval_s?: number;
}

/** Sayaç alanları (son BR_HEALTH'ten bu yana fark) → JSON anahtarı. */
const COUNTER_FIELDS: readonly string[] = [
  "MAC_TX_TOTAL",
  "MAC_TX_UNICAST",
  "MAC_TX_ACK_REQUESTED",
  "MAC_TX_ACKED",
  "MAC_TX_RETRY",
  "MAC_TX_ERR_CCA",
  "MAC_TX_ERR_ABORT",
  "MAC_TX_ERR_BUSY_CHANNEL",
  "MAC_RX_TOTAL",
  "MAC_RX_DUPLICATED",
  "MAC_RX_ERR_FCS",
  "MAC_RX_ERR_SEC",
  "MAC_RX_ERR_NO_FRAME",
  "MAC_RX_ERR_UNKNOWN_NEIGHBOR",
  "MAC_RX_ERR_OTHER",
  "IP_TX_SUCCESS",
  "IP_TX_FAILURE",
  "IP_RX_SUCCESS",
  "IP_RX_FAILURE",
];

export function brHealthJson(fields: Fields, cache: BrBuildInfo, ctx: ConvertContext): Json {
  const idf = num(fields, "HEALTH_IDF_VERSION");
  if (idf !== null) cache.idf_version = versionText(idf, true);
  const built = num(fields, "HEALTH_BUILD_TIMESTAMP");
  if (built !== null) [cache.build_date, cache.build_time] = buildDateTime(built);
  const networkName = fields.get("THREAD_NETWORK_NAME");
  if (typeof networkName === "string") cache.network_name = networkName;
  const healthInterval = num(fields, "HEALTH_INTERVAL_S");
  if (healthInterval !== null && healthInterval > 0) cache.health_interval_s = healthInterval;
  const topologyInterval = num(fields, "HEALTH_TOPOLOGY_INTERVAL_S");
  if (topologyInterval !== null && topologyInterval > 0) cache.topology_interval_s = topologyInterval;

  const fw = num(fields, "HEALTH_FIRMWARE_VERSION");
  const partition = num(fields, "THREAD_PARTITION_ID");
  const pan = num(fields, "THREAD_PAN_ID");
  const target = num(fields, "OTA_LAST_TARGET_VERSION");
  const otaError = num(fields, "OTA_LAST_ERROR");

  const counters: Json = { period_s: num(fields, "COUNTERS_PERIOD_S") };
  for (const name of COUNTER_FIELDS) counters[name.toLowerCase()] = num(fields, name);

  return {
    type: "thread_br",
    fw: fw !== null ? versionText(fw) : null,
    uptime_s: num(fields, "HEALTH_UPTIME_S"),
    free_heap_bytes: num(fields, "HEALTH_FREE_HEAP_BYTES"),
    min_free_heap_bytes: num(fields, "HEALTH_MIN_FREE_HEAP_BYTES"),
    reset_reason: enumName(RESET_REASONS, num(fields, "HEALTH_RESET_REASON"), ctx, "HEALTH_RESET_REASON"),
    mqtt_connects: num(fields, "HEALTH_MQTT_CONNECTS"),
    mqtt_publish_fails: num(fields, "HEALTH_MQTT_PUBLISH_FAILS"),
    idf_version: cache.idf_version ?? null,
    build_date: cache.build_date ?? null,
    build_time: cache.build_time ?? null,
    health_interval_s: cache.health_interval_s ?? null,
    topology_interval_s: cache.topology_interval_s ?? null,
    uplink: {
      kind: "wifi",
      connected: bool(fields, "WIFI_CONNECTED"),
      rssi: num(fields, "WIFI_RSSI"),
      channel: num(fields, "WIFI_CHANNEL"),
      connected_s: num(fields, "WIFI_CONNECTED_S"),
      disconnects: num(fields, "WIFI_DISCONNECTS"),
      last_disconnect_reason: num(fields, "WIFI_LAST_DISCONNECT_REASON"),
      beacon_timeouts: num(fields, "WIFI_BEACON_TIMEOUTS"),
    },
    thread: {
      role: enumName(THREAD_ROLES, num(fields, "THREAD_ROLE"), ctx, "THREAD_ROLE"),
      rloc16: num(fields, "THREAD_RLOC16"),
      // Ondalık metin: lambanın health'iyle (lib/gatewayLink.ts) metin olarak
      // karşılaştırılır ve panelde binlik ayraçla gösterilmez.
      partition_id: partition !== null ? String(partition) : null,
      channel: num(fields, "THREAD_CHANNEL"),
      pan_id: pan !== null ? `0x${hex(pan, 4)}` : null,
      network_name: cache.network_name ?? null,
      leader_router_id: num(fields, "LEADER_ROUTER_ID"),
      router_count: num(fields, "ROUTER_COUNT"),
      child_count: num(fields, "CHILD_COUNT"),
      neighbor_count: num(fields, "NEIGHBOR_COUNT"),
      netdata_version: num(fields, "NETDATA_VERSION"),
      stable_netdata_version: num(fields, "STABLE_NETDATA_VERSION"),
      detached_count: num(fields, "DETACHED_COUNT"),
      leader_count: num(fields, "LEADER_COUNT"),
      border_routing_state: enumName(
        BORDER_ROUTING_STATES,
        num(fields, "BORDER_ROUTING_STATE"),
        ctx,
        "BORDER_ROUTING_STATE",
      ),
      border_agent_active: bool(fields, "BORDER_AGENT_ACTIVE"),
      cca_failure_pct: ratePct(num(fields, "CCA_FAILURE_RATE")),
      partition_id_changes: num(fields, "THREAD_PARTITION_ID_CHANGES"),
      attach_attempts: num(fields, "THREAD_ATTACH_ATTEMPTS"),
    },
    counters,
    ota: {
      state: enumName(OTA_STATES, num(fields, "OTA_STATE"), ctx, "OTA_STATE"),
      last_result: enumName(OTA_RESULTS, num(fields, "OTA_LAST_RESULT"), ctx, "OTA_LAST_RESULT"),
      busy: bool(fields, "OTA_BUSY"),
      check_count: num(fields, "OTA_CHECK_COUNT"),
      last_check_uptime_s: num(fields, "OTA_LAST_CHECK_UPTIME_S"),
      last_success_uptime_s: num(fields, "OTA_LAST_SUCCESS_UPTIME_S"),
      last_target_version: target !== null ? versionText(target) : null,
      last_error: otaError !== null && otaError !== 0 ? espErrToName(otaError) : null,
    },
  };
}

// ── Topoloji (BR_NEIGHBORS / BR_ROUTES) ─────────────────────

export interface BrNeighbor {
  rloc16: number;
  /** rloc16 >> 10 */
  router_id: number;
  ext_addr: string | null;
  role: "child" | "router" | null;
  rssi_avg_dbm: number | null;
  rssi_last_dbm: number | null;
  link_margin_db: number | null;
  lq_in: number | null;
  /** Yalnızca router komşuda. */
  lq_out: number | null;
  age_s: number | null;
  frame_error_pct: number | null;
  message_error_pct: number | null;
  thread_version: number | null;
}

export interface BrRoute {
  router_id: number;
  rloc16: number | null;
  /** null = yol yok / gateway'in kendisi (63). */
  next_hop: number | null;
  path_cost: number | null;
  lq_in: number | null;
  lq_out: number | null;
  age_s: number | null;
  link_established: boolean | null;
}

export type BrTopologyKind = "neighbors" | "routes";

export interface BrTopologyPage {
  kind: BrTopologyKind;
  snapshotId: number | null;
  page: number;
  lastPage: boolean;
  total: number | null;
  items: BrNeighbor[] | BrRoute[];
}

/**
 * Sayfalı topoloji paketi. Kayıtlar tekrar eden alanlardır: her NB_RLOC16
 * (komşu) / RT_ROUTER_ID (rota) yeni kayıt başlatır, sonraki alanlar ona aittir.
 */
export function brTopologyPage(kind: BrTopologyKind, entries: readonly FieldEntry[]): BrTopologyPage {
  const fields: Fields = new Map(entries);
  const items: Array<Record<string, unknown>> = [];
  const starter = kind === "neighbors" ? "NB_RLOC16" : "RT_ROUTER_ID";
  const prefix = kind === "neighbors" ? "NB_" : "RT_";
  for (const [name, value] of entries) {
    if (name === starter) {
      const fresh = kind === "neighbors" ? emptyNeighbor(value as number) : emptyRoute(value as number);
      items.push(fresh as unknown as Record<string, unknown>);
      continue;
    }
    if (!name.startsWith(prefix) || items.length === 0) continue;
    const cur = items[items.length - 1];
    if (kind === "neighbors") applyNeighbor(cur, name, value);
    else applyRoute(cur, name, value);
  }
  return {
    kind,
    snapshotId: num(fields, "SNAPSHOT_ID"),
    page: num(fields, "PAGE") ?? 0,
    lastPage: num(fields, "LAST_PAGE") === 1,
    total: num(fields, "TOTAL"),
    items: items as unknown as BrNeighbor[] | BrRoute[],
  };
}

function emptyNeighbor(rloc16: number): BrNeighbor {
  return {
    rloc16,
    router_id: rloc16 >> 10,
    ext_addr: null,
    role: null,
    rssi_avg_dbm: null,
    rssi_last_dbm: null,
    link_margin_db: null,
    lq_in: null,
    lq_out: null,
    age_s: null,
    frame_error_pct: null,
    message_error_pct: null,
    thread_version: null,
  };
}

function applyNeighbor(n: Record<string, unknown>, name: string, value: FieldValue): void {
  const v = typeof value === "number" ? value : null;
  switch (name) {
    case "NB_EXT_ADDR":
      n.ext_addr = value instanceof Uint8Array ? Array.from(value, (b) => hex(b, 2)).join("") : null;
      break;
    case "NB_IS_CHILD":
      n.role = v === null ? null : v ? "child" : "router";
      break;
    case "NB_RSSI_AVG":
      n.rssi_avg_dbm = v;
      break;
    case "NB_RSSI_LAST":
      n.rssi_last_dbm = v;
      break;
    case "NB_LINK_MARGIN":
      n.link_margin_db = v;
      break;
    case "NB_LQ_IN":
      n.lq_in = v;
      break;
    case "NB_LQ_OUT":
      n.lq_out = v;
      break;
    case "NB_AGE_S":
      n.age_s = v;
      break;
    case "NB_FRAME_ERROR_RATE":
      n.frame_error_pct = ratePct(v);
      break;
    case "NB_MESSAGE_ERROR_RATE":
      n.message_error_pct = ratePct(v);
      break;
    case "NB_THREAD_VERSION":
      n.thread_version = v;
      break;
  }
}

function emptyRoute(routerId: number): BrRoute {
  return {
    router_id: routerId,
    rloc16: null,
    next_hop: null,
    path_cost: null,
    lq_in: null,
    lq_out: null,
    age_s: null,
    link_established: null,
  };
}

function applyRoute(r: Record<string, unknown>, name: string, value: FieldValue): void {
  const v = typeof value === "number" ? value : null;
  switch (name) {
    case "RT_RLOC16":
      r.rloc16 = v;
      break;
    case "RT_NEXT_HOP":
      r.next_hop = v === null || v === BR_NO_NEXT_HOP ? null : v;
      break;
    case "RT_PATH_COST":
      r.path_cost = v;
      break;
    case "RT_LQ_IN":
      r.lq_in = v;
      break;
    case "RT_LQ_OUT":
      r.lq_out = v;
      break;
    case "RT_AGE_S":
      r.age_s = v;
      break;
    case "RT_LINK_ESTABLISHED":
      r.link_established = v === null ? null : v !== 0;
      break;
  }
}

// ── Komut yanıtı ─────────────────────────────────────────────

export interface BrAck {
  /** Komut geldiyse geri döner; bozuk komutta null. */
  action: string | null;
  /** u16 kısa id; komutta yoksa null. */
  id: number | null;
  result: number;
  status: "ok" | "error";
  error: string | null;
}

export function brAckJson(fields: Fields): BrAck {
  const result = num(fields, "COMMAND_RESULT") ?? 0;
  const actionCode = num(fields, "COMMAND_ACTION");
  const id = num(fields, "COMMAND_ID");
  return {
    action: actionCode === null ? null : (BR_COMMAND_ACTIONS[actionCode] ?? `action ${actionCode}`),
    id: id === null || id === 0 ? null : id,
    result,
    status: result === 0 ? "ok" : "error",
    error: result === 0 ? null : (BR_COMMAND_RESULT_TEXTS[result] ?? `bilinmeyen hata kodu (${result})`),
  };
}

// ── Giriş noktası ────────────────────────────────────────────

export type BrMessage =
  | { kind: "health"; json: Json }
  | { kind: "topology"; page: BrTopologyPage }
  | { kind: "ack"; ack: BrAck };

/** Uplink mesajı. COMMAND (sunucu → gateway) ve tanınmayan tip → null. */
export function brToMessage(frame: DecodedFrame, cache: BrBuildInfo, ctx: ConvertContext): BrMessage | null {
  const fields: Fields = new Map(frame.fields);
  switch (frame.typeName) {
    case "BR_HEALTH":
      return { kind: "health", json: brHealthJson(fields, cache, ctx) };
    case "BR_NEIGHBORS":
      return { kind: "topology", page: brTopologyPage("neighbors", frame.fields) };
    case "BR_ROUTES":
      return { kind: "topology", page: brTopologyPage("routes", frame.fields) };
    case "COMMAND_ACK":
      return { kind: "ack", ack: brAckJson(fields) };
    default:
      return null;
  }
}
