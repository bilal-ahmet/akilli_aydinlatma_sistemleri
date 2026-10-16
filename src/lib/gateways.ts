/**
 * Gateway (ağ geçidi) kataloğu — SAF modül, istemci de kullanır.
 *
 * Gateway'ler cihazlarla AYNI topic şemasını kullanır (firmware ekibinin
 * tercihi): `Meven:<GW_ID>/cmd`, `Meven:<GW_ID>/data`, `Meven:<GW_ID>/health`.
 * Topic'ten ayırt edilemedikleri için backend mesajı payload'daki `type`
 * alanıyla ayırır: değer bu dosyadaki `GATEWAY_TYPES`'tan biriyse mesaj
 * gateway'indir. Cihazlar bu değerleri hiç kullanmaz (`d4i_periodic`,
 * `health`). Kontrat: firmware/GATEWAY-ENTEGRASYON.md.
 *
 * Paket türden türe değişir: ortak zarf (`type`, `fw`, `uptime_s`, `online`,
 * `uplink`) + türe özgü blok (`thread`, `cellular`, `wifi`, `lorawan`). Türe
 * özgü alanlar burada tanımlanmış olanlardan ibaret değildir — tanınmayan
 * alanlar yutulmaz, admin'e ham haliyle gösterilir (deviceErrors.ts ilkesi).
 */

export const GATEWAY_TYPES = ["thread_br", "cellular", "wifi", "lorawan"] as const;
export type GatewayType = (typeof GATEWAY_TYPES)[number];

export function isGatewayType(v: unknown): v is GatewayType {
  return typeof v === "string" && (GATEWAY_TYPES as readonly string[]).includes(v);
}

/** Payload bir gateway mesajı mı? (`type` gateway türlerinden biri.) */
export function isGatewayPayload(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && isGatewayType((raw as { type?: unknown }).type);
}

/**
 * Gateway'in "çalışıyor" sayıldığı pencere. Health ~30 sn'de bir gelir; iki
 * kaçan mesaja tolerans. LWT (`online:false`) geldiyse pencere beklenmez.
 */
export const GATEWAY_ONLINE_WINDOW_MS = 2 * 60_000;

type FieldFormat = "text" | "int" | "dbm" | "duration";

interface FieldDef {
  key: string;
  label: string;
  /** Müşteriye gösterilecekse sade etiket; yoksa alan yalnızca admin'e görünür. */
  plainLabel?: string;
  format?: FieldFormat;
  /** Değer çevirisi (örn. Thread rolü). */
  values?: Record<string, string>;
}

interface TypeInfo {
  label: string;
  plainLabel: string;
  /** Türe özgü bloğun payload'daki anahtarı. */
  block: string;
  fields: FieldDef[];
}

export const GATEWAY_TYPE_INFO: Record<GatewayType, TypeInfo> = {
  thread_br: {
    label: "Thread Border Router",
    plainLabel: "Lamba ağı geçidi",
    block: "thread",
    fields: [
      {
        key: "role",
        label: "Thread rolü",
        values: {
          leader: "Leader",
          router: "Router",
          child: "Child",
          detached: "Detached (ağdan kopuk)",
          disabled: "Disabled",
        },
      },
      { key: "network_name", label: "Ağ adı" },
      { key: "channel", label: "Kanal", format: "int" },
      { key: "pan_id", label: "PAN ID" },
      { key: "ext_pan_id", label: "Ext PAN ID" },
      { key: "partition_id", label: "Partition ID" },
      { key: "router_count", label: "Router sayısı", format: "int" },
      { key: "child_count", label: "Child sayısı", format: "int" },
    ],
  },
  cellular: {
    label: "4G router",
    plainLabel: "Mobil hat (4G) geçidi",
    block: "cellular",
    fields: [
      { key: "operator", label: "Operatör", plainLabel: "Operatör" },
      { key: "network", label: "Şebeke tipi" },
      { key: "rssi", label: "RSSI", plainLabel: "Sinyal", format: "dbm" },
      { key: "rsrp", label: "RSRP", format: "dbm" },
      { key: "iccid", label: "SIM ICCID" },
    ],
  },
  wifi: {
    label: "WiFi router",
    plainLabel: "WiFi geçidi",
    block: "wifi",
    fields: [
      { key: "ssid", label: "SSID", plainLabel: "Ağ adı" },
      { key: "rssi", label: "RSSI", plainLabel: "Sinyal", format: "dbm" },
      { key: "clients", label: "Bağlı istemci", format: "int" },
    ],
  },
  lorawan: {
    label: "LoRaWAN gateway",
    plainLabel: "Uzun menzilli ağ geçidi",
    block: "lorawan",
    fields: [
      { key: "gateway_eui", label: "Gateway EUI" },
      { key: "frequency_plan", label: "Frekans planı" },
      { key: "rx_packets", label: "Alınan paket", format: "int" },
      { key: "tx_packets", label: "Gönderilen paket", format: "int" },
    ],
  },
};

/** Tür etiketi; tanınmayan tür admin'e ham haliyle, müşteriye "Ağ geçidi" olarak. */
export function gatewayTypeLabel(type: string, technical: boolean): string {
  if (!isGatewayType(type)) return technical ? type : "Ağ geçidi";
  const info = GATEWAY_TYPE_INFO[type];
  return technical ? info.label : info.plainLabel;
}

const UPLINK_KINDS: Record<string, string> = {
  ethernet: "Kablolu (Ethernet)",
  wifi: "WiFi",
  cellular: "Mobil hat (4G)",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** "3 gün 4 sa", "5 sa 12 dk", "42 dk", "30 sn". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} gün ${h} sa`;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk`;
  return `${s} sn`;
}

function formatValue(v: unknown, def?: FieldDef): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (def?.values && typeof v === "string") return def.values[v] ?? v;
  if (typeof v === "number") {
    if (def?.format === "dbm") return `${v} dBm`;
    if (def?.format === "duration") return formatUptime(v);
    return new Intl.NumberFormat("tr-TR").format(v);
  }
  if (typeof v === "boolean") return v ? "Evet" : "Hayır";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export interface GatewayField {
  label: string;
  value: string;
}

/**
 * Panelde gösterilecek alanlar: önce ortak zarf (yazılım sürümü, çalışma
 * süresi, internet bağlantısı), sonra türe özgü blok. Son `/health` ve son
 * `/data` mesajı birlikte okunur (alan hangisinde gelirse).
 *
 * Admin: tanımlı tüm alanlar + bloktaki tanınmayan alanlar (ham).
 * Müşteri: yalnızca `plainLabel`'ı olan alanlar.
 */
export function summarizeGateway(
  g: {
    type: string;
    health: Record<string, unknown> | null;
    report: Record<string, unknown> | null;
  },
  opts: { technical: boolean },
): GatewayField[] {
  const { technical } = opts;
  const pick = (key: string): unknown => g.health?.[key] ?? g.report?.[key];
  const out: GatewayField[] = [];
  const push = (label: string, value: string | null) => {
    if (value !== null) out.push({ label, value });
  };

  if (technical) push("Firmware", formatValue(pick("fw")));
  const uptime = pick("uptime_s");
  if (typeof uptime === "number") push("Çalışma süresi", formatUptime(uptime));

  const uplink = asRecord(pick("uplink"));
  if (uplink) {
    const kind = typeof uplink.kind === "string" ? uplink.kind : null;
    if (kind) push("İnternet bağlantısı", UPLINK_KINDS[kind] ?? kind);
    if (typeof uplink.rssi === "number") {
      push(technical ? "Uplink RSSI" : "Sinyal", `${uplink.rssi} dBm`);
    }
    if (technical) push("IP", formatValue(uplink.ip));
  }

  const nodes = pick("nodes");
  if (Array.isArray(nodes)) push("Bağlı cihaz", String(nodes.length));

  const info = isGatewayType(g.type) ? GATEWAY_TYPE_INFO[g.type] : null;
  const block = info ? asRecord(pick(info.block)) : null;
  if (info && block) {
    const known = new Set<string>();
    for (const def of info.fields) {
      known.add(def.key);
      if (!technical && !def.plainLabel) continue;
      push(technical ? def.label : def.plainLabel!, formatValue(block[def.key], def));
    }
    if (technical) {
      for (const [key, v] of Object.entries(block)) {
        if (!known.has(key)) push(key, formatValue(v));
      }
    }
  }
  return out;
}

/**
 * Gateway raporundaki `nodes` listesinden cihaz MAC'leri (iki noktasız, büyük
 * harf). Liste yoksa null — "boş liste" ile "bilgi yok" ayrı tutulur: boş
 * liste gateway'e bağlı cihaz kalmadığını söyler.
 */
export function nodeMacsFromReport(report: unknown): string[] | null {
  const nodes = asRecord(report)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const macs = new Set<string>();
  for (const n of nodes) {
    const raw = typeof n === "string" ? n : asRecord(n)?.mac;
    if (typeof raw !== "string") continue;
    const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (/^[0-9A-F]{12}$/.test(hex)) macs.add(hex);
  }
  return [...macs];
}

export type GatewayState = "online" | "offline" | "never";

/**
 * Durum: hiç rapor yok → "never"; LWT geldi ya da pencere doldu → "offline".
 * `now` null (ilk render, saat henüz yok) iken null döner — yargıya varılmaz.
 */
export function gatewayState(
  g: { lastSeen: string | null; online: boolean | null },
  now: number | null,
): GatewayState | null {
  if (!g.lastSeen) return "never";
  if (g.online === false) return "offline";
  if (now === null) return null;
  return now - new Date(g.lastSeen).getTime() < GATEWAY_ONLINE_WINDOW_MS ? "online" : "offline";
}
