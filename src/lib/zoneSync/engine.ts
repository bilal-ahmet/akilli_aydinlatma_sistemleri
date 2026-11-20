import { eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { peekTenancy, type TenancyIndex } from "@/lib/tenancy";
import { binSeen } from "@/lib/binUplink";
import { zoneSyncMode } from "@/lib/env";
import { emitLiveEvent } from "@/lib/events";
import { resultCodeOf } from "@/lib/binproto/fields";
import type { CommandAck } from "@/types/lighting";
import {
  ZONES_PER_DEVICE,
  applyZoneOp,
  classifyZoneResult,
  desiredZones,
  isDeviceZoneSlug,
  planZoneOps,
  sameZoneSet,
  type ZoneOp,
  type ZoneSyncStatus,
  type ZoneSyncView,
} from "./plan";

/**
 * Dinamik bölge aboneliği motoru (sunucu, tek instance — Kural #8).
 *
 * Her kayıtlı cihaz için İSTENEN topic listesini (bölge + alt gruplar, tenancy
 * index'inden, DB'siz) cihazın BİLİNEN listesine (device_zone_sync.reported)
 * getirir. Cihaz başına aynı anda tek komut uçuştadır; ack gelince fark
 * yeniden hesaplanır (bkz. plan.ts). Çevrimdışı cihaz komutu kaçırırsa
 * (kalıcı oturum yok; QoS 2 de çevrimdışı cihaza saklanmaz) HELLO'da ya da sıradaki /bin paketinde
 * kalınan yerden devam edilir — istenen durum DB'de olduğu için restart'ta
 * da kaybolmaz.
 *
 * Kurallar:
 *  - Zone komutu YALNIZCA binary ve YALNIZCA Meven:<MAC>/cmd'ye gider (cihaz
 *    başka topic'ten geleni -21 ile reddeder); yalnızca binary paketi görülmüş
 *    cihaza (binSeen), hiç bağlanmamış kayda gitmez.
 *  - Bilinmeyen cihaza ilk temas `zone_list`'tir (alan taşımaz): eski binary
 *    firmware -5 döner → `unsupported`; 0xA9 içeren paket ona hiç gitmez.
 *    `unsupported`, health'te firmware sürümü değişince sıfırlanır.
 *  - Kayıtsız MAC'e dokunulmaz; daha önce yönetilmiş (satırı olan) ama artık
 *    kayıtsız cihazın istenen listesi ∅'dir → zone_clear (silinen cihaz/bölge).
 *  - Işık komut yolunda değildir: CRUD route'ları yalnızca bellek içi `kick`
 *    çağırır (Kural #10). DB yazımı ack işlenirken, arka planda yapılır.
 */

const ACK_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3; // aynı komut, yanıtsız
const MAX_RETRYABLE = 3; // -14/-15/-20 art arda
const RETRY_BACKOFF_MS = 30_000;
const PARK_MS = 10 * 60_000; // yanıtsız kalınca uplink'le yeniden denemeden önce
const MAX_CONCURRENT = 8; // aynı anda uçuşta komutu olan cihaz (Thread ağı tıkanmasın)
const HELLO_JITTER_MIN_MS = 3_000;
const HELLO_JITTER_MAX_MS = 15_000;

type Inflight = {
  requestId: string;
  shortId: number;
  op: ZoneOp;
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
};

type DeviceState = {
  reported: string[] | null;
  reportedAt: number | null;
  status: ZoneSyncStatus;
  lastError: string | null;
  lastErrorAt: number | null;
  unsupportedFw: string | null;
  firmware: string | null;
  /** DB'de satırı var (daha önce yönetildi) — kayıtsızsa temizlik yapılır. */
  managed: boolean;
  inflight: Inflight | null;
  /** HELLO sonrası: önce zone_list ile doğrula. */
  verify: boolean;
  /** Bu zamandan önce kendiliğinden adım atılmaz (geri çekilme / park). */
  retryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Geçici hata sayacı (-14/-15/-20). */
  retryable: number;
  /** Kalıcı hata: istenen değişene / HELLO'ya / elle doğrulamaya kadar durur. */
  halted: boolean;
};

export type ZonePublisher = (
  mac: string,
  op: ZoneOp,
  reuse?: { requestId: string; shortId: number },
) => { requestId: string; shortId: number };

type Store = {
  devices: Map<string, DeviceState>;
  active: Set<string>;
  waiting: string[];
  publish: ZonePublisher | null;
  seeded: boolean;
};

const g = globalThis as unknown as { __fenerZoneSync?: Store };
const store: Store = (g.__fenerZoneSync ??= {
  devices: new Map(),
  active: new Set(),
  waiting: [],
  publish: null,
  seeded: false,
});

/** lib/mqtt.ts kayıt eder (döngüsel import olmasın diye motor mqtt'yi import etmez). */
export function registerZonePublisher(fn: ZonePublisher): void {
  store.publish = fn;
}

function ensure(mac: string): DeviceState {
  let st = store.devices.get(mac);
  if (!st) {
    st = {
      reported: null,
      reportedAt: null,
      status: "unknown",
      lastError: null,
      lastErrorAt: null,
      unsupportedFw: null,
      firmware: null,
      managed: false,
      inflight: null,
      verify: false,
      retryAt: 0,
      retryTimer: null,
      retryable: 0,
      halted: false,
    };
    store.devices.set(mac, st);
  }
  return st;
}

/** İstenen liste: geçerli slug'lar + cihaz kuralına uymayanlar (gönderilemez). */
function desiredFor(idx: TenancyIndex | undefined, mac: string): { valid: string[]; invalid: string[] } {
  const all = desiredZones(idx?.deviceZone.get(mac), idx?.deviceGroups.get(mac));
  return {
    valid: all.filter(isDeviceZoneSlug),
    invalid: all.filter((z) => !isDeviceZoneSlug(z)),
  };
}

function registered(idx: TenancyIndex | undefined, mac: string): boolean {
  return !!idx?.deviceZone.has(mac);
}

// ── Kalıcılık + canlı olay ───────────────────────────────────

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

function publicView(st: DeviceState): ZoneSyncView {
  return { status: st.status, error: st.lastError, errorAt: iso(st.lastErrorAt) };
}

async function persist(mac: string, st: DeviceState): Promise<void> {
  const idx = peekTenancy();
  try {
    // Kayıtsız ve temizlenmiş cihazın satırına gerek yok.
    if (!registered(idx, mac) && st.reported !== null && st.reported.length === 0 && !st.inflight) {
      await db.delete(schema.deviceZoneSync).where(eq(schema.deviceZoneSync.mac, mac));
      st.managed = false;
      return;
    }
    const values = {
      reported: st.reported,
      reportedAt: st.reportedAt == null ? null : new Date(st.reportedAt),
      status: st.status,
      lastError: st.lastError?.slice(0, 200) ?? null,
      lastErrorAt: st.lastErrorAt == null ? null : new Date(st.lastErrorAt),
      unsupportedFw: st.unsupportedFw,
      updatedAt: new Date(),
    };
    await db
      .insert(schema.deviceZoneSync)
      .values({ mac, ...values })
      .onConflictDoUpdate({ target: schema.deviceZoneSync.mac, set: values });
    st.managed = true;
  } catch (err) {
    console.error(`[zone] durum yazılamadı (${mac}):`, err instanceof Error ? err.message : err);
  }
}

function setStatus(mac: string, st: DeviceState, status: ZoneSyncStatus, error?: string | null): void {
  const changed = st.status !== status || (error !== undefined && error !== st.lastError);
  st.status = status;
  if (error !== undefined) {
    st.lastError = error;
    st.lastErrorAt = error ? Date.now() : null;
  }
  if (!changed) return;
  emitLiveEvent({
    deviceId: mac,
    kind: "zone_sync",
    status: status === "error" ? "error" : "ok",
    zoneSync: publicView(st),
    at: new Date().toISOString(),
  });
}

// ── Eşzamanlılık sınırı ──────────────────────────────────────

function release(mac: string): void {
  store.active.delete(mac);
  while (store.active.size < MAX_CONCURRENT && store.waiting.length > 0) {
    const next = store.waiting.shift()!;
    step(next);
  }
}

function scheduleStep(mac: string, st: DeviceState, delayMs: number): void {
  if (st.retryTimer) clearTimeout(st.retryTimer);
  st.retryTimer = setTimeout(() => {
    st.retryTimer = null;
    step(mac);
  }, delayMs);
  st.retryTimer.unref?.();
}

// ── Adım ─────────────────────────────────────────────────────

/**
 * Cihaz için sıradaki komutu hesaplar ve gönderir (uçuşta yoksa). Senkron;
 * DB'ye dokunmaz, yalnızca durum değişince arka planda yazar.
 */
function step(mac: string): void {
  const mode = zoneSyncMode();
  if (mode === "off" || !store.publish) return;
  const st = ensure(mac);
  if (st.inflight || st.halted) return;
  if (Date.now() < st.retryAt) {
    scheduleStep(mac, st, st.retryAt - Date.now());
    return;
  }
  const idx = peekTenancy();
  if (!idx) return;
  if (!registered(idx, mac) && !st.managed) return; // hiç yönetilmemiş kayıtsız MAC
  // Hiç bağlanmamış (binary paketi görülmemiş) kayda komut atılmaz.
  if (!binSeen(mac)) return;
  if (st.status === "unsupported" && st.unsupportedFw === st.firmware) return;

  const { valid, invalid } = desiredFor(idx, mac);
  let op: ZoneOp | undefined;
  if (st.verify || st.reported === null) {
    op = { action: "zone_list", zones: [] };
  } else if (valid.length > ZONES_PER_DEVICE) {
    setStatus(mac, st, "error", `cihaz en fazla ${ZONES_PER_DEVICE} bölge dinleyebilir (istenen ${valid.length})`);
    void persist(mac, st);
    return;
  } else {
    op = planZoneOps(st.reported, valid)[0];
  }

  if (!op) {
    // Fark yok. Kural dışı slug'lı bölge/grup cihaza hiç gönderilemez.
    if (invalid.length > 0) {
      setStatus(mac, st, "error", `bölge adı cihaz kuralına uymuyor: ${invalid.join(", ")}`);
    } else {
      setStatus(mac, st, "synced", null);
    }
    void persist(mac, st);
    return;
  }

  if (op.action !== "zone_list" && mode === "observe") {
    // İzleme modu: fark görünür, cihaza dokunulmaz.
    setStatus(mac, st, "pending");
    void persist(mac, st);
    return;
  }

  if (!store.active.has(mac) && store.active.size >= MAX_CONCURRENT) {
    if (!store.waiting.includes(mac)) store.waiting.push(mac);
    return;
  }
  send(mac, st, op);
}

function send(mac: string, st: DeviceState, op: ZoneOp, reuse?: Inflight): void {
  let sent: { requestId: string; shortId: number };
  try {
    sent = store.publish!(mac, op, reuse ? { requestId: reuse.requestId, shortId: reuse.shortId } : undefined);
  } catch (err) {
    // Yalnızca kendi doğrulamamız (encodeCommand) atar → kalıcı hata.
    console.error(`[zone] komut üretilemedi (${mac} ${op.action}):`, err instanceof Error ? err.message : err);
    st.halted = true;
    setStatus(mac, st, "error", err instanceof Error ? err.message : String(err));
    void persist(mac, st);
    return;
  }
  store.active.add(mac);
  const attempt = (reuse?.attempt ?? 0) + 1;
  const timer = setTimeout(() => onTimeout(mac), ACK_TIMEOUT_MS);
  timer.unref?.();
  st.inflight = { ...sent, op, attempt, timer };
  setStatus(mac, st, "pending");
}

function onTimeout(mac: string): void {
  const st = store.devices.get(mac);
  const inf = st?.inflight;
  if (!st || !inf) return;
  if (inf.attempt < MAX_ATTEMPTS && zoneSyncMode() !== "off") {
    send(mac, st, inf.op, inf); // aynı kısa id: geç gelen ilk ack de eşleşsin
    return;
  }
  st.inflight = null;
  release(mac);
  // Çevrimdışı: HELLO ya da park süresi sonrası ilk uplink'le sürer.
  st.retryAt = Date.now() + PARK_MS;
  console.warn(`[zone] ${mac}: ${inf.op.action} ${MAX_ATTEMPTS} denemede yanıtsız — cihaz bağlanınca sürecek`);
  setStatus(mac, st, "no_response");
  void persist(mac, st);
}

// ── Dış olaylar ──────────────────────────────────────────────

/**
 * İstenen liste değişti (CRUD) ya da cihaz kaydı değişti. Bellek içi, senkron;
 * route'lar `refreshTenancy()` sonrası çağırır.
 */
export function kick(macs: Iterable<string>): void {
  for (const mac of macs) {
    const st = ensure(mac);
    st.halted = false;
    st.retryable = 0;
    st.retryAt = 0;
    if (!registered(peekTenancy(), mac)) st.managed = st.managed || st.reported !== null;
    step(mac);
  }
}

/** Cihaz bağlandı (binary HELLO): listeyi doğrula, kalan işleri sürdür. */
export function onHello(mac: string): void {
  const idx = peekTenancy();
  const st = store.devices.get(mac);
  if (!registered(idx, mac) && !st?.managed) return;
  const s = ensure(mac);
  // Yeniden başlayan cihaz uçuştaki komutu almamış olabilir.
  if (s.inflight) {
    clearTimeout(s.inflight.timer);
    s.inflight = null;
    release(mac);
  }
  s.verify = true;
  s.halted = false;
  s.retryable = 0;
  s.retryAt = 0;
  const jitter = HELLO_JITTER_MIN_MS + Math.random() * (HELLO_JITTER_MAX_MS - HELLO_JITTER_MIN_MS);
  scheduleStep(mac, s, jitter);
}

/** Cihazdan geçerli bir /bin paketi geldi: iş kaldıysa ve beklemiyorsa sürdür. */
export function onUplink(mac: string): void {
  const st = store.devices.get(mac);
  const idx = peekTenancy();
  if (!st && !registered(idx, mac)) return;
  const s = st ?? ensure(mac);
  if (s.inflight || s.halted || s.retryTimer || Date.now() < s.retryAt) return;
  if (s.status === "synced" && !s.verify && s.reported !== null) {
    // Hızlı yol: istenen değişmediyse hiçbir şey yapma.
    if (sameZoneSet(s.reported, desiredFor(idx, mac).valid)) return;
  }
  step(mac);
}

/** Health'teki firmware sürümü — `unsupported` sürüm değişince yeniden denenir. */
export function noteFirmware(mac: string, version: string | null): void {
  if (!version) return;
  const st = store.devices.get(mac);
  if (!st) {
    if (registered(peekTenancy(), mac)) ensure(mac).firmware = version;
    return;
  }
  if (st.firmware === version) return;
  st.firmware = version;
  if (st.status === "unsupported" && st.unsupportedFw !== version) {
    st.reported = null;
    st.halted = false;
    setStatus(mac, st, "unknown", null);
    void persist(mac, st);
    step(mac);
  }
}

/** Elle doğrulama (panel "Şimdi doğrula"): zone_list + fark. */
export function forceVerify(mac: string): { sent: boolean; reason?: "off" | "not_seen" | "busy" } {
  if (zoneSyncMode() === "off") return { sent: false, reason: "off" };
  if (!binSeen(mac)) return { sent: false, reason: "not_seen" };
  const st = ensure(mac);
  if (st.inflight) return { sent: false, reason: "busy" };
  st.verify = true;
  st.halted = false;
  st.retryable = 0;
  st.retryAt = 0;
  if (st.status === "unsupported") {
    // Kullanıcı bilerek yeniden deniyor (sürüm değişmemiş olsa da).
    st.unsupportedFw = null;
    setStatus(mac, st, "unknown", null);
  }
  step(mac);
  return { sent: true };
}

/**
 * Zone komutunun ack'i (binary; lib/mqtt.ts handleZoneAck). Lamba
 * hatası değildir: rozete/arıza geçmişine yazılmaz, durum burada tutulur.
 */
export async function onAck(mac: string, ack: CommandAck, requestId: string | undefined): Promise<void> {
  const st = ensure(mac);
  const inf = st.inflight;
  const matches =
    !!inf && (requestId ? requestId === inf.requestId : !!ack.action && ack.action === inf.op.action);
  const now = Date.now();

  if (!matches) {
    // Eski / eşlenemeyen ack (restart, başka instance, zaman aşımı sonrası).
    // zone_list'in listesi yine de doğrudur; diğerlerinde bilinen belirsizleşir.
    if (ack.action === "zone_list" && ack.status === "ok") {
      st.reported = [...(ack.zones ?? [])];
      st.reportedAt = now;
      st.verify = false;
    } else if (!inf && ack.status === "ok") {
      st.reported = null;
    }
    await persist(mac, st);
    if (!inf) step(mac);
    return;
  }

  clearTimeout(inf.timer);
  st.inflight = null;
  release(mac);

  if (ack.status === "ok") {
    st.reported = applyZoneOp(st.reported ?? [], inf.op, ack.zones);
    st.reportedAt = now;
    if (inf.op.action === "zone_list") st.verify = false;
    if (ack.zone_count !== undefined && ack.zone_count !== st.reported.length) {
      console.warn(
        `[zone] ${mac}: ${inf.op.action} sonrası cihaz ${ack.zone_count} bölge diyor, beklenen ${st.reported.length} — liste yeniden okunacak`,
      );
      st.reported = null;
    }
    st.retryable = 0;
    if (st.status === "error" || st.status === "no_response") setStatus(mac, st, "pending", null);
    await persist(mac, st);
    step(mac);
    return;
  }

  const error = (ack.error ?? "cihaz zone komutunu reddetti").slice(0, 200);
  // Ya hep ya hiç: değişiklik uygulanmadı. Sayı uyuşmuyorsa liste yeniden okunur.
  if (ack.zone_count !== undefined && st.reported && ack.zone_count !== st.reported.length) st.reported = null;
  const verdict = classifyZoneResult(resultCodeOf(error));
  console.warn(`[zone] ${mac}: ${inf.op.action} reddedildi (${verdict}): ${error}`);

  if (verdict === "unsupported") {
    st.unsupportedFw = st.firmware;
    setStatus(mac, st, "unsupported", error);
  } else if (verdict === "retry" && st.retryable < MAX_RETRYABLE) {
    st.retryable += 1;
    st.retryAt = now + RETRY_BACKOFF_MS * st.retryable;
    scheduleStep(mac, st, RETRY_BACKOFF_MS * st.retryable);
    await persist(mac, st);
    return;
  } else {
    st.halted = true;
    setStatus(mac, st, "error", error);
  }
  await persist(mac, st);
}

// ── Okuma ────────────────────────────────────────────────────

/** Cihazın senkron durumu. `detail` (admin): istenen + bildirilen liste. */
export function zoneSyncView(mac: string, detail = false): ZoneSyncView {
  const st = store.devices.get(mac);
  const view: ZoneSyncView = st ? publicView(st) : { status: "unknown", error: null, errorAt: null };
  if (detail) {
    const idx = peekTenancy();
    view.desired = desiredZones(idx?.deviceZone.get(mac), idx?.deviceGroups.get(mac));
    view.reported = st?.reported ?? null;
    view.reportedAt = iso(st?.reportedAt ?? null);
  }
  return view;
}

/** `GET /api/devices` ve cihaz yanıtları için: alt grupları + senkron durumu. */
export function zoneExtrasFor(mac: string): { groups: string[]; zoneSync: ZoneSyncView } {
  return { groups: [...(peekTenancy()?.deviceGroups.get(mac) ?? [])], zoneSync: zoneSyncView(mac) };
}

export type ZoneSyncSnapshot = {
  mode: "on" | "observe" | "off";
  counts: Partial<Record<ZoneSyncStatus, number>>;
  inflight: number;
  waiting: number;
  devices: Array<
    ZoneSyncView & { mac: string; customer: string | null; registered: boolean; inflightOp: string | null }
  >;
  invalidSlugs: Array<{ slug: string; kind: "zone" | "group"; customer: string | null }>;
};

/** Admin kartı: senkron dışı cihazlar (istenen vs bildirilen) ve kural dışı slug'lar. */
export function zoneSyncSnapshot(): ZoneSyncSnapshot {
  const idx = peekTenancy();
  const counts: Partial<Record<ZoneSyncStatus, number>> = {};
  const macs = new Set<string>([...(idx?.deviceZone.keys() ?? []), ...store.devices.keys()]);
  const devices: ZoneSyncSnapshot["devices"] = [];
  for (const mac of macs) {
    const st = store.devices.get(mac);
    const isRegistered = registered(idx, mac);
    if (!isRegistered && !st?.managed) continue;
    const view = zoneSyncView(mac, true);
    counts[view.status] = (counts[view.status] ?? 0) + 1;
    if (view.status === "synced" || (view.status === "unknown" && !st)) continue;
    const cid = idx?.deviceOwner.get(mac);
    devices.push({
      ...view,
      mac,
      customer: cid ? (idx?.customersById.get(cid)?.name ?? null) : null,
      registered: isRegistered,
      inflightOp: st?.inflight?.op.action ?? null,
    });
  }
  const invalidSlugs: ZoneSyncSnapshot["invalidSlugs"] = [];
  const nameOf = (cid: string | undefined) => (cid ? (idx?.customersById.get(cid)?.name ?? null) : null);
  for (const [slug, cid] of idx?.zoneOwner ?? []) {
    if (!isDeviceZoneSlug(slug)) invalidSlugs.push({ slug, kind: "zone", customer: nameOf(cid) });
  }
  for (const [slug, cid] of idx?.groupOwner ?? []) {
    if (!isDeviceZoneSlug(slug)) invalidSlugs.push({ slug, kind: "group", customer: nameOf(cid) });
  }
  return {
    mode: zoneSyncMode(),
    counts,
    inflight: store.active.size,
    waiting: store.waiting.length,
    devices,
    invalidSlugs,
  };
}

/** MAC düzeltmesi: eski (yanlış girilmiş) MAC'in hiç doğrulanmamış durumu atılır. */
export async function forgetUnverified(mac: string): Promise<void> {
  const st = store.devices.get(mac);
  if (st && st.reported !== null) return; // gerçek cihaz konuşmuş: temizlik sürsün
  if (st?.inflight) clearTimeout(st.inflight.timer);
  store.devices.delete(mac);
  store.active.delete(mac);
  await db.delete(schema.deviceZoneSync).where(eq(schema.deviceZoneSync.mac, mac));
}

/**
 * Açılışta durumu DB'den yükler (instrumentation). Komut basılmaz; cihazların
 * ilk uplink'i / HELLO'su beklenir.
 */
export async function seedZoneSync(): Promise<void> {
  const [rows, fw] = await Promise.all([
    db.select().from(schema.deviceZoneSync),
    db
      .select({ mac: schema.devices.deviceId, firmware: schema.devices.firmwareVersion })
      .from(schema.devices)
      .where(isNotNull(schema.devices.firmwareVersion)),
  ]);
  for (const r of rows) {
    if (store.devices.has(r.mac)) continue; // canlı bilgi daha yeni
    const st = ensure(r.mac);
    st.reported = r.reported ?? null;
    st.reportedAt = r.reportedAt?.getTime() ?? null;
    st.status = (r.status as ZoneSyncStatus) ?? "unknown";
    st.lastError = r.lastError;
    st.lastErrorAt = r.lastErrorAt?.getTime() ?? null;
    st.unsupportedFw = r.unsupportedFw;
    st.managed = true;
    // Restart'ta uçuştaki komut kayboldu; bekleyen iş uplink'te sürer.
    if (st.status === "pending") st.retryAt = 0;
  }
  for (const f of fw) {
    const st = store.devices.get(f.mac);
    if (st) st.firmware ??= f.firmware;
  }
  store.seeded = true;
  console.log(`[zone] bölge senkronu yüklendi: ${rows.length} cihaz durumu, mod ${zoneSyncMode()}`);
}
