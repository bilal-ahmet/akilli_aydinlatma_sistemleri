import { eq, isNotNull, sql } from "drizzle-orm";
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
import { BR_PROTOCOL_VERSION } from "@/lib/binproto/brFields";
import { brToMessage, type BrBuildInfo, type BrMessage } from "@/lib/binproto/brToJson";

/**
 * Meven:<MAC>/bin alım katmanı (sunucu). Binary paketi doğrular, çözer ve
 * backend'in iç JSON biçimine çevirir; çıktı lib/mqtt.ts'te routeUplink ile
 * işlenir. Python köprüsünün (mqtt_bridge.py) yerini tutar — ayrı servis yok.
 * Cihazdan JSON KABUL EDİLMEZ: /data ve /health'e gelen JSON yalnızca sayılır
 * (noteRejectedJson) ve admin kartında "JSON gönderen cihaz" olarak görünür.
 *
 * Bellek içi tutulanlar (globalThis, tek instance — Kural #8):
 *  - Health'in bağlantı başına bir kez gelen alanları (idf_version, derleme
 *    zamanı, Thread ağ adı). Backend her deploy'da yeniden başladığı için
 *    önbellek boşsa `devices.health`'teki son değerle tohumlanır.
 *  - Sayaçlar ve son retler → admin kartı (GET /api/admin/binproto). Doküman
 *    "tanımsız alan gelirse paketi atın ve alarm üretin" diyor; alarm budur.
 *  - Cihaz başına son geçerli binary zamanı → bölge senkronu kapısı (binSeen).
 *  - JSON gönderen (reddedilen) MAC'ler → admin kartı.
 */

/** Binary paketin akıbeti: kabul ya da ret/atlama nedeni. */
export type BinOutcome =
  | "accepted"
  | Exclude<RejectReason, "LORA">
  | "MISSING_FIELD"
  | "LORA" // LoRa gateway protokolü (0x02) — henüz desteklenmiyor, hata değil
  | "UNKNOWN_TYPE" // tanınmayan mesaj tipi — dokümana göre loglanıp atlanır
  | "GATEWAY"; // kayıtlı bir gateway kimliğinden gelen v1 (lamba) paketi

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

const ALARM_WINDOW_MS = 24 * 60 * 60_000;
const LOG_INTERVAL_MS = 60 * 60_000;
const MAX_RECENT = 50;

type RejectInfo = { mac: string; at: number; outcome: BinOutcome; detail: string; hex: string };

type DeviceBinState = {
  firstAt: number;
  lastAt: number;
  lastValidAt: number | null;
  frames: number;
  lastType: string | null;
  lastReject: RejectInfo | null;
};

/** /data ya da /health'e JSON basan (eski firmware) MAC — işlenmez, yalnızca sayılır. */
type JsonReject = { firstAt: number; lastAt: number; count: number; topic: "data" | "health" };

type Store = {
  since: number;
  counts: Map<BinOutcome, number>;
  devices: Map<string, DeviceBinState>;
  recent: RejectInfo[];
  lastAlarm: RejectInfo | null;
  buildInfo: Map<string, BuildInfo>;
  /** Border Router (0x03) başına, MQTT bağlantısı başına bir kez gelen health alanları. */
  brBuildInfo: Map<string, BrBuildInfo>;
  logged: Map<string, number>;
  /** MAC → reddedilen JSON mesajları. */
  jsonRejected: Map<string, JsonReject>;
};

const g = globalThis as unknown as { __fenerBin?: Store };
const store: Store = (g.__fenerBin ??= {
  since: Date.now(),
  counts: new Map(),
  devices: new Map(),
  recent: [],
  lastAlarm: null,
  buildInfo: new Map(),
  brBuildInfo: new Map(),
  logged: new Map(),
  jsonRejected: new Map(),
});
store.jsonRejected ??= new Map(); // HMR: eski store nesnesinde alan yok
store.brBuildInfo ??= new Map();

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
    d = { firstAt: now, lastAt: now, lastValidAt: null, frames: 0, lastType: null, lastReject: null };
    store.devices.set(mac, d);
  }
  d.lastAt = now;
  d.frames += 1;
  return d;
}

function count(outcome: BinOutcome): void {
  store.counts.set(outcome, (store.counts.get(outcome) ?? 0) + 1);
}

/**
 * Paketi atar ve sayar. `dev` null = Border Router paketi (0x03): cihaz binary
 * durumuna yazılmaz, retin ayrıntısı "BR" önekini taşır.
 */
function reject(
  mac: string,
  dev: DeviceBinState | null,
  outcome: BinOutcome,
  detail: string,
  payload: Uint8Array,
  now: number,
): BinSkip {
  count(outcome);
  if (!dev) detail = `BR ${detail}`;
  const info: RejectInfo = { mac, at: now, outcome, detail, hex: toHex(payload.subarray(0, 64)) };
  if (outcome !== "LORA" && outcome !== "GATEWAY") {
    if (dev) dev.lastReject = info;
    store.recent.unshift(info);
    if (store.recent.length > MAX_RECENT) store.recent.length = MAX_RECENT;
  }
  if (ALARM_OUTCOMES.has(outcome)) {
    store.lastAlarm = info;
    logOnce(
      `${mac}:${outcome}:${detail}`,
      "error",
      `[bin] ALARM ${mac}: ${detail} — paket atıldı. ${dev ? "Cihaz" : "Ağ geçidi"} backend'den yeni ` +
        `bir alan tablosu kullanıyor; src/lib/binproto/${dev ? "fields.ts" : "brFields.ts"} ` +
        `güncellenmeli. ${info.hex}`,
      now,
    );
  } else if (outcome === "LORA") {
    logOnce(`${mac}:LORA`, "warn", `[bin] ${mac}: LoRa gateway paketi (0x02) — henüz desteklenmiyor, atlandı`, now);
  } else {
    logOnce(`${mac}:${outcome}`, "warn", `[bin] ${mac}: paket reddedildi (${outcome}: ${detail}) ${info.hex}`, now);
  }
  return { kind: "skip", outcome, detail, hex: info.hex };
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

/** Atlanan/reddedilen paket: neden + ilk 64 baytın hex'i (JSON aynası için). */
export type BinSkip = { kind: "skip"; outcome: BinOutcome; detail: string; hex: string };
/** Border Router (0x03) mesajı — cihaz yolundan ayrı işlenir (lib/mqtt.ts → handleBrUplink). */
export type BrUplink = { kind: "br"; msg: BrMessage };
export type BinUplinkResult = LegacyMessage | BinSkip | BrUplink;

/**
 * Bir `/bin` paketini işler. Dönen iç JSON routeUplink'e verilir. Paketin tamamı doğrulanmadan hiçbir alan
 * kullanılmaz; bozuk / tanımsız alanlı paket atılır ve sayılır.
 */
export async function decodeBinUplink(mac: string, payload: Uint8Array): Promise<BinUplinkResult> {
  const now = Date.now();
  if (payload.length > 0 && payload[0] === BR_PROTOCOL_VERSION) return decodeBrUplink(mac, payload, now);
  const dev = touch(mac, now);

  const frame = decodeFrame(payload);
  if (!frame.ok) return reject(mac, dev, frame.reason, frame.detail, payload, now);
  dev.lastType = frame.typeName ?? `0x${frame.type.toString(16)}`;

  if (!frame.typeName || frame.typeName === "COMMAND") {
    return reject(mac, dev, "UNKNOWN_TYPE", `bilinmeyen mesaj tipi ${frame.type}`, payload, now);
  }
  // Ağ geçitleri yalnızca 0x03 basar. Kayıtlı bir ağ geçidi kimliğinden gelen
  // lamba paketi cihaz yoluna düşmesin (aynı MAC hem cihaz hem gateway olamaz).
  if (peekTenancy()?.gatewayOwner.has(mac)) {
    return reject(mac, dev, "GATEWAY", `kayıtlı gateway kimliği (${frame.typeName})`, payload, now);
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

/** Ağ geçidinin bir-kezlik health alanları; önbellekte yoksa son kayıtlı health'ten. */
async function brBuildInfoFor(mac: string): Promise<BrBuildInfo> {
  const cached = store.brBuildInfo.get(mac);
  if (cached) return cached;
  const info: BrBuildInfo = {};
  if (peekTenancy()?.gatewayOwner.has(mac)) {
    try {
      const [row] = await db
        .select({ health: schema.gateways.health })
        .from(schema.gateways)
        .where(eq(schema.gateways.gatewayId, mac))
        .limit(1);
      const h = (row?.health ?? null) as Record<string, unknown> | null;
      const thread = (h?.thread ?? null) as Record<string, unknown> | null;
      const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
      const pos = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
      const seeded: BrBuildInfo = {
        idf_version: str(h?.idf_version),
        build_date: str(h?.build_date),
        build_time: str(h?.build_time),
        network_name: str(thread?.network_name),
        health_interval_s: pos(h?.health_interval_s),
        topology_interval_s: pos(h?.topology_interval_s),
      };
      for (const [k, v] of Object.entries(seeded)) {
        if (v !== undefined) (info as Record<string, unknown>)[k] = v;
      }
    } catch (err) {
      console.warn(`[bin] BR health önbelleği tohumlanamadı (${mac}):`, err instanceof Error ? err.message : err);
    }
  }
  const raced = store.brBuildInfo.get(mac);
  if (raced) return raced;
  store.brBuildInfo.set(mac, info);
  return info;
}

/**
 * Border Router paketi (ilk bayt 0x03). Sayaçlar, son retler ve alan tablosu
 * alarmı lamba paketleriyle ortaktır (admin kartı); cihaz binary durumuna
 * (binSeen, admin cihaz listesi) yazılmaz.
 */
async function decodeBrUplink(mac: string, payload: Uint8Array, now: number): Promise<BrUplink | BinSkip> {
  const frame = decodeFrame(payload);
  if (!frame.ok) return reject(mac, null, frame.reason, frame.detail, payload, now);
  if (!frame.typeName || frame.typeName === "COMMAND") {
    return reject(mac, null, "UNKNOWN_TYPE", `bilinmeyen mesaj tipi ${frame.type}`, payload, now);
  }
  const cache: BrBuildInfo = frame.typeName === "BR_HEALTH" ? await brBuildInfoFor(mac) : {};
  const ctx: ConvertContext = { warnings: [] };
  const msg = brToMessage(frame, cache, ctx);
  for (const w of ctx.warnings) {
    logOnce(`${mac}:enum:${w}`, "warn", `[bin] BR ${mac} ${frame.typeName}: ${w} — "unknown" yazıldı`, now);
  }
  if (!msg) return reject(mac, null, "UNKNOWN_TYPE", `çevrilemeyen tip ${frame.typeName}`, payload, now);
  count("accepted");
  return { kind: "br", msg };
}

/** Ağ geçidi silinince bellekteki bir-kezlik alanları unut (MAC başka yere kaydedilebilir). */
export function forgetBrGateway(mac: string): void {
  store.brBuildInfo.delete(mac);
}

/**
 * Bu MAC'ten geçerli binary paket görüldü mü (bu süreçte ya da açılışta DB'den
 * tohumlanarak)? Bölge senkronu yalnızca bu cihazlara zone komutu gönderir:
 * hiç bağlanmamış kayıtlara komut atıp `no_response`'a düşürmesin.
 */
export function binSeen(mac: string): boolean {
  return store.devices.get(mac)?.lastValidAt != null;
}

/**
 * /data ya da /health'e JSON geldi (eski firmware). İşlenmez — cihaz binary
 * firmware'e güncellenene kadar panelde bağlantısız görünür. Admin kartı bu
 * cihazları listeler ki sessizce kaybolmasınlar.
 */
export function noteRejectedJson(mac: string, topic: "data" | "health", now = Date.now()): void {
  const r = store.jsonRejected.get(mac);
  if (r) {
    r.lastAt = now;
    r.count += 1;
    r.topic = topic;
  } else {
    store.jsonRejected.set(mac, { firstAt: now, lastAt: now, count: 1, topic });
  }
  logOnce(
    `${mac}:json`,
    "warn",
    `[bin] ${mac}: JSON mesajı (/${topic}) reddedildi — yalnızca binary protokol kabul edilir, firmware güncellenmeli`,
    now,
  );
}

/**
 * Açılışta "binary görülmüş" bilgisini DB'den geri yükler (bölge senkronu
 * kapısı, binSeen); yoksa her deploy'dan sonra cihazın ilk paketine kadar
 * panelden bölge değişikliği / "Şimdi doğrula" gönderilemezdi.
 *
 * Binary işareti: son health'i bizim çeviricimizden çıkmışsa `health_interval_s`
 * anahtarını taşır (toJson her zaman yazar, değer null olabilir), ya da cihaz
 * rapor aralığını bildirmiştir (yalnızca binary firmware bildirir). Bellekte
 * zaten kaydı olan cihaza dokunulmaz (canlı bilgi daha yenidir).
 */
export async function seedBinStateFromDb(): Promise<void> {
  const rows = await db
    .select({
      mac: schema.devices.deviceId,
      lastSeen: schema.devices.lastSeen,
      binHealth: sql<boolean>`coalesce(jsonb_exists(${schema.devices.health}, 'health_interval_s'), false)`,
      reportIntervalS: schema.devices.reportIntervalS,
      healthIntervalS: schema.devices.healthIntervalS,
    })
    .from(schema.devices)
    .where(isNotNull(schema.devices.lastSeen));
  let bin = 0;
  for (const r of rows) {
    if (!(r.binHealth || r.reportIntervalS != null || r.healthIntervalS != null)) continue;
    if (store.devices.has(r.mac)) continue;
    const seen = r.lastSeen!.getTime();
    store.devices.set(r.mac, {
      firstAt: seen,
      lastAt: seen,
      lastValidAt: seen,
      frames: 0,
      lastType: null,
      lastReject: null,
    });
    bin += 1;
  }
  console.log(`[bin] binary cihazlar DB'den yüklendi: ${bin}`);
}

// ── Admin özeti ──────────────────────────────────────────────

export type BinProtoSnapshot = {
  since: string;
  counts: Partial<Record<BinOutcome, number>>;
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
  }>;
  /** /data ya da /health'e JSON gönderen (reddedilen) MAC'ler, son mesaj sırasıyla. */
  jsonRejected: Array<{
    mac: string;
    label: string | null;
    firstAt: string;
    lastAt: string;
    count: number;
    topic: "data" | "health";
  }>;
  recent: Array<{ mac: string; label: string | null; at: string; outcome: BinOutcome; detail: string; hex: string }>;
};

/** "Müşteri adı" (kayıtlı cihaz) — kayıtsız MAC'te null. */
function labelFor(idx: TenancyIndex | undefined, mac: string): string | null {
  const cid = idx?.deviceOwner.get(mac);
  return cid ? (idx?.customersById.get(cid)?.name ?? null) : null;
}

export function binProtoSnapshot(idx: TenancyIndex | undefined, now = Date.now()): BinProtoSnapshot {
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
      })),
    jsonRejected: [...store.jsonRejected.entries()]
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .map(([mac, r]) => ({
        mac,
        label: labelFor(idx, mac),
        firstAt: iso(r.firstAt),
        lastAt: iso(r.lastAt),
        count: r.count,
        topic: r.topic,
      })),
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
