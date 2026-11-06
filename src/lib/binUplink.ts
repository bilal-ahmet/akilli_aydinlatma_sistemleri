import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { peekTenancy, type TenancyIndex } from "@/lib/tenancy";
import { decodeFrame, toHex, type RejectReason } from "@/lib/binproto/codec";
import {
  MissingFieldError,
  toLegacy,
  type BuildInfo,
  type ConvertContext,
  type LegacyMessage,
} from "@/lib/binproto/toJson";

/**
 * Meven:<MAC>/bin alım katmanı (sunucu). Binary paketi doğrular, çözer ve
 * cihazın eski JSON'una çevirir; çıktı lib/mqtt.ts'te JSON'la gelen mesajla
 * AYNI yoldan (routeUplink) işlenir. Python köprüsünün (mqtt_bridge.py) yerini
 * tutar — ayrı servis yok, broker'dan mesaj iki kez geçmez.
 *
 * Bellek içi tutulanlar (globalThis, tek instance — Kural #8):
 *  - Health'in bağlantı başına bir kez gelen alanları (idf_version, derleme
 *    zamanı, Thread ağ adı). Backend her deploy'da yeniden başladığı için
 *    önbellek boşsa `devices.health`'teki son değerle tohumlanır.
 *  - Sayaçlar ve son retler → admin kartı (GET /api/admin/binproto). Doküman
 *    "tanımsız alan gelirse paketi atın ve alarm üretin" diyor; alarm budur.
 *  - Cihaz başına son geçerli binary zamanı → çift işleme koruması (binActive)
 *    ve komut biçimi seçimi (binCommandCapable).
 */

/** Binary paketin akıbeti: kabul ya da ret/atlama nedeni. */
export type BinOutcome =
  | "accepted"
  | Exclude<RejectReason, "LORA">
  | "MISSING_FIELD"
  | "LORA" // LoRa gateway protokolü (0x02) — henüz desteklenmiyor, hata değil
  | "UNKNOWN_TYPE" // tanınmayan mesaj tipi — dokümana göre loglanıp atlanır
  | "GATEWAY"; // kayıtlı bir gateway kimliğinden gelen v1 paketi

/** Alan tablosu uyuşmazlığı: cihaz backend'in bilmediği bir tablo kullanıyor. */
const ALARM_OUTCOMES: ReadonlySet<BinOutcome> = new Set(["FIELD", "MISSING_FIELD"]);
/** Bozuk paket (iletim / firmware hatası) — uyarı, alarm değil. */
const CORRUPT_OUTCOMES: ReadonlySet<BinOutcome> = new Set([
  "TOO_SHORT",
  "VERSION",
  "CRC",
  "TRUNCATED",
  "NO_TYPE",
]);

/** JSON telemetrisi bu süre içinde binary göndermiş MAC'ten gelirse atlanır. */
const BIN_ACTIVE_MS = 10 * 60_000;
const ALARM_WINDOW_MS = 24 * 60 * 60_000;
const LOG_INTERVAL_MS = 60 * 60_000;
const MAX_RECENT = 50;

type RejectInfo = { mac: string; at: number; outcome: BinOutcome; detail: string; hex: string };

type DeviceBinState = {
  firstAt: number;
  lastAt: number;
  lastValidAt: number | null;
  /** Bu MAC'ten son JSON telemetri/health (ack hariç) — firmware geri dönüşü. */
  lastJsonAt: number | null;
  frames: number;
  lastType: string | null;
  lastReject: RejectInfo | null;
};

type Store = {
  since: number;
  counts: Map<BinOutcome, number>;
  devices: Map<string, DeviceBinState>;
  recent: RejectInfo[];
  lastAlarm: RejectInfo | null;
  buildInfo: Map<string, BuildInfo>;
  duplicateJson: number;
  logged: Map<string, number>;
};

const g = globalThis as unknown as { __fenerBin?: Store };
const store: Store = (g.__fenerBin ??= {
  since: Date.now(),
  counts: new Map(),
  devices: new Map(),
  recent: [],
  lastAlarm: null,
  buildInfo: new Map(),
  duplicateJson: 0,
  logged: new Map(),
});

/** Aynı anahtar için saatte en fazla bir log (cihaz her 30 sn aynı paketi basabilir). */
function logOnce(key: string, level: "warn" | "error", message: string, now: number): void {
  const last = store.logged.get(key);
  if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
  store.logged.set(key, now);
  console[level](message);
}

function touch(mac: string, now: number): DeviceBinState {
  let d = store.devices.get(mac);
  if (!d) {
    d = { firstAt: now, lastAt: now, lastValidAt: null, lastJsonAt: null, frames: 0, lastType: null, lastReject: null };
    store.devices.set(mac, d);
  }
  d.lastAt = now;
  d.frames += 1;
  return d;
}

function count(outcome: BinOutcome): void {
  store.counts.set(outcome, (store.counts.get(outcome) ?? 0) + 1);
}

function reject(
  mac: string,
  dev: DeviceBinState,
  outcome: BinOutcome,
  detail: string,
  payload: Uint8Array,
  now: number,
): { kind: "skip" } {
  count(outcome);
  const info: RejectInfo = { mac, at: now, outcome, detail, hex: toHex(payload.subarray(0, 64)) };
  if (outcome !== "LORA" && outcome !== "GATEWAY") {
    dev.lastReject = info;
    store.recent.unshift(info);
    if (store.recent.length > MAX_RECENT) store.recent.length = MAX_RECENT;
  }
  if (ALARM_OUTCOMES.has(outcome)) {
    store.lastAlarm = info;
    logOnce(
      `${mac}:${outcome}:${detail}`,
      "error",
      `[bin] ALARM ${mac}: ${detail} — paket atıldı. Cihaz backend'den yeni bir alan tablosu ` +
        `kullanıyor; src/lib/binproto/fields.ts güncellenmeli. ${info.hex}`,
      now,
    );
  } else if (outcome === "LORA") {
    logOnce(`${mac}:LORA`, "warn", `[bin] ${mac}: LoRa gateway paketi (0x02) — henüz desteklenmiyor, atlandı`, now);
  } else {
    logOnce(`${mac}:${outcome}`, "warn", `[bin] ${mac}: paket reddedildi (${outcome}: ${detail}) ${info.hex}`, now);
  }
  return { kind: "skip" };
}

/** Cihazın bir-kezlik health alanları; önbellekte yoksa son kayıtlı health'ten. */
async function buildInfoFor(mac: string): Promise<BuildInfo> {
  const cached = store.buildInfo.get(mac);
  if (cached) return cached;
  const info: BuildInfo = {};
  try {
    const [row] = await db
      .select({ health: schema.devices.health })
      .from(schema.devices)
      .where(eq(schema.devices.deviceId, mac))
      .limit(1);
    const h = (row?.health ?? null) as Record<string, unknown> | null;
    const thread = (h?.thread ?? null) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
    const seeded: BuildInfo = {
      idf_version: str(h?.idf_version),
      build_date: str(h?.build_date),
      build_time: str(h?.build_time),
      network_name: str(thread?.network_name),
    };
    for (const [k, v] of Object.entries(seeded)) if (v !== undefined) info[k as keyof BuildInfo] = v;
  } catch (err) {
    console.warn(`[bin] health önbelleği tohumlanamadı (${mac}):`, err instanceof Error ? err.message : err);
  }
  // Tohumlama beklenirken başka bir health önbelleği doldurmuş olabilir.
  const raced = store.buildInfo.get(mac);
  if (raced) return raced;
  store.buildInfo.set(mac, info);
  return info;
}

export type BinUplinkResult = LegacyMessage | { kind: "skip" };

/**
 * Bir `/bin` paketini işler. Dönen JSON, cihaz onu doğrudan JSON olarak
 * basmış gibi routeUplink'e verilir. Paketin tamamı doğrulanmadan hiçbir alan
 * kullanılmaz; bozuk / tanımsız alanlı paket atılır ve sayılır.
 */
export async function decodeBinUplink(mac: string, payload: Uint8Array): Promise<BinUplinkResult> {
  const now = Date.now();
  const dev = touch(mac, now);

  const frame = decodeFrame(payload);
  if (!frame.ok) return reject(mac, dev, frame.reason, frame.detail, payload, now);
  dev.lastType = frame.typeName ?? `0x${frame.type.toString(16)}`;

  if (!frame.typeName || frame.typeName === "COMMAND") {
    return reject(mac, dev, "UNKNOWN_TYPE", `bilinmeyen mesaj tipi ${frame.type}`, payload, now);
  }
  // Gateway'ler v1 cihaz protokolünü kullanmaz; kayıtlı gateway kimliğinden
  // gelen paket cihaz yoluna düşmesin.
  if (peekTenancy()?.gatewayOwner.has(mac)) {
    return reject(mac, dev, "GATEWAY", "kayıtlı gateway kimliği", payload, now);
  }

  const buildInfo: BuildInfo = frame.typeName === "HEALTH" ? await buildInfoFor(mac) : {};
  const ctx: ConvertContext = { warnings: [] };
  let result: LegacyMessage | null;
  try {
    result = toLegacy(frame, `Meven:${mac}`, buildInfo, ctx);
  } catch (err) {
    if (err instanceof MissingFieldError) {
      return reject(mac, dev, "MISSING_FIELD", `${frame.typeName}: ${err.message}`, payload, now);
    }
    throw err;
  }
  for (const w of ctx.warnings) {
    logOnce(`${mac}:enum:${w}`, "warn", `[bin] ${mac} ${frame.typeName}: ${w} — "unknown" yazıldı`, now);
  }
  if (!result) return reject(mac, dev, "UNKNOWN_TYPE", `çevrilemeyen tip ${frame.typeName}`, payload, now);

  count("accepted");
  dev.lastValidAt = now;
  return result;
}

/**
 * Bu MAC son 10 dk'da geçerli binary paket gönderdi mi? Öyleyse aynı MAC'ten
 * gelen JSON telemetri/health ikinci kopyadır (doğrulama firmware'i ikisini
 * birden basıyor ya da biri canlı broker'da Python köprüsünü köprü modunda
 * çalıştırıyor) ve atlanır. JSON komut yanıtları (ack) bu kurala girmez:
 * JSON komuta cihaz yeni firmware'de de JSON ack döner.
 */
export function binActive(mac: string, now = Date.now()): boolean {
  const at = store.devices.get(mac)?.lastValidAt;
  return at != null && now - at < BIN_ACTIVE_MS;
}

/**
 * Bu MAC'e komut binary gönderilebilir mi? Son 10 dk'da geçerli binary paket
 * gelmiş VE ondan sonra JSON telemetri/health gelmemiş olmalı. İkinci şart
 * OTA geri dönüşünü yakalar (eski firmware'e dönen cihaz JSON basar, binary
 * komutu anlamaz); köprü yanlışlıkla köprü modunda çalışırsa da güvenli yöne
 * (JSON) kayar. Cihaz geçiş döneminde JSON komutu da kabul eder.
 */
export function binCommandCapable(mac: string, now = Date.now()): boolean {
  const d = store.devices.get(mac);
  if (!d || d.lastValidAt == null || now - d.lastValidAt >= BIN_ACTIVE_MS) return false;
  return d.lastJsonAt == null || d.lastJsonAt < d.lastValidAt;
}

/**
 * Bu MAC'ten JSON telemetri/health geldi (ack değil). Yalnızca binary görülmüş
 * cihazlar için tutulur — eski firmware'li filo belleği büyütmez.
 */
export function noteJsonUplink(mac: string, now = Date.now()): void {
  const d = store.devices.get(mac);
  if (d) d.lastJsonAt = now;
}

export function noteDuplicateJson(mac: string): void {
  store.duplicateJson += 1;
  logOnce(
    `${mac}:dupjson`,
    "warn",
    `[bin] ${mac}: binary gönderen cihazdan JSON telemetri geldi — ikinci kopya atlandı`,
    Date.now(),
  );
}

// ── Admin özeti ──────────────────────────────────────────────

export type BinProtoSnapshot = {
  since: string;
  counts: Partial<Record<BinOutcome, number>>;
  duplicateJson: number;
  /** Son 24 saatte alan tablosu uyuşmazlığı (FIELD / MISSING_FIELD) oldu mu. */
  alarm: { mac: string; at: string; outcome: BinOutcome; detail: string; label: string | null } | null;
  /** Son 24 saatte bozuk paket sayısı (CRC, kısa, taşma…). */
  corruptRecent: number;
  devices: Array<{
    mac: string;
    label: string | null;
    lastAt: string;
    lastValidAt: string | null;
    frames: number;
    lastType: string | null;
    lastReject: { at: string; outcome: BinOutcome; detail: string } | null;
    /** Şu an komutlar bu cihaza hangi biçimde gider (tek cihaz komutu). */
    commandFormat: "binary" | "json";
  }>;
  /** MQTT_BINARY_COMMANDS=off ise false: bütün komutlar JSON. */
  binaryCommands: boolean;
  recent: Array<{ mac: string; label: string | null; at: string; outcome: BinOutcome; detail: string; hex: string }>;
};

/** "Müşteri adı" (kayıtlı cihaz) — kayıtsız MAC'te null. */
function labelFor(idx: TenancyIndex | undefined, mac: string): string | null {
  const cid = idx?.deviceOwner.get(mac);
  return cid ? (idx?.customersById.get(cid)?.name ?? null) : null;
}

export function binProtoSnapshot(
  idx: TenancyIndex | undefined,
  binaryCommands: boolean,
  now = Date.now(),
): BinProtoSnapshot {
  const iso = (t: number) => new Date(t).toISOString();
  const alarm =
    store.lastAlarm && now - store.lastAlarm.at < ALARM_WINDOW_MS
      ? {
          mac: store.lastAlarm.mac,
          at: iso(store.lastAlarm.at),
          outcome: store.lastAlarm.outcome,
          detail: store.lastAlarm.detail,
          label: labelFor(idx, store.lastAlarm.mac),
        }
      : null;
  return {
    since: iso(store.since),
    counts: Object.fromEntries(store.counts),
    duplicateJson: store.duplicateJson,
    alarm,
    corruptRecent: store.recent.filter((r) => CORRUPT_OUTCOMES.has(r.outcome) && now - r.at < ALARM_WINDOW_MS)
      .length,
    devices: [...store.devices.entries()]
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .map(([mac, d]) => ({
        mac,
        label: labelFor(idx, mac),
        lastAt: iso(d.lastAt),
        lastValidAt: d.lastValidAt === null ? null : iso(d.lastValidAt),
        frames: d.frames,
        lastType: d.lastType,
        lastReject: d.lastReject
          ? { at: iso(d.lastReject.at), outcome: d.lastReject.outcome, detail: d.lastReject.detail }
          : null,
        commandFormat: binaryCommands && binCommandCapable(mac, now) ? "binary" : "json",
      })),
    binaryCommands,
    recent: store.recent.map((r) => ({
      mac: r.mac,
      label: labelFor(idx, r.mac),
      at: iso(r.at),
      outcome: r.outcome,
      detail: r.detail,
      hex: r.hex,
    })),
  };
}
