import type { OtaStatus } from "@/types/lighting";

/**
 * OTA (ota_check) güvenliği — bellek içi.
 *
 * Firmware ekibinin saha notu: aynı anda indirme yapan cihazlar Thread ağını
 * tıkıyor ve indirmeler yarıda kalıyor. Bu yüzden OTA cihazlara TEK TEK, arada
 * birkaç dakika bırakılarak gönderilir. Toplu topic'e (bölge / all) hiç
 * gönderilmez (bkz. lib/mqtt.ts publishMaintenance); burası aynı bölgede
 * art arda tekil istekleri sıraya sokar.
 *
 * Kaynak: cihazın ~30 sn'lik `/health` mesajı (handleHealth → noteHealth) ve
 * gönderilen OTA istekleri (noteOtaSent). Sunucu yeniden başlayınca boş
 * başlar — kabul edilebilir: ilk health mesajlarıyla 30 sn içinde dolar.
 * Tek instance varsayımına dayanır (Kural #8).
 */

type HealthSnap = { firmwareVersion: string | null; ota: OtaStatus | null; at: number };

const g = globalThis as unknown as {
  __fenerHealth?: Map<string, HealthSnap>;
  __fenerOtaSent?: Map<string, number>;
};
const health = (g.__fenerHealth ??= new Map());
const otaSent = (g.__fenerOtaSent ??= new Map());

/** Bundan eski health mesajı "busy" kanıtı sayılmaz (cihaz OTA sırasında düşmüş olabilir). */
const HEALTH_STALE_MS = 5 * 60_000;
/** Aynı bölgede iki OTA isteği arasında beklenecek süre. */
export const OTA_ZONE_COOLDOWN_MS = 3 * 60_000;
/**
 * İstekten bu kadar sonra gelen health "cihaz işi bitirdi" kanıtıdır. Hemen
 * ardından gelen mesaj cihaz kontrole başlamadan önce yayınlanmış olabilir.
 */
const HEALTH_AFTER_SEND_MS = 10_000;

const BUSY_STATES = new Set(["checking", "downloading", "verifying"]);

function isBusy(ota: OtaStatus | null | undefined): boolean {
  if (!ota) return false;
  if (typeof ota.busy === "boolean") return ota.busy;
  return !!ota.state && BUSY_STATES.has(ota.state);
}

export function noteHealth(mac: string, snap: Omit<HealthSnap, "at">, at = Date.now()): void {
  health.set(mac, { ...snap, at });
}

export function noteOtaSent(mac: string, at = Date.now()): void {
  otaSent.set(mac, at);
}

/** Cihaz şu an OTA yapıyor mu (taze health'e göre)? */
function busyNow(mac: string, now: number): boolean {
  const h = health.get(mac);
  return !!h && now - h.at < HEALTH_STALE_MS && isBusy(h.ota);
}

/**
 * Komşu cihaz ağı meşgul ediyor mu: ya taze health'i "busy" diyor ya da son
 * birkaç dakikada OTA isteği almış ve o zamandan beri "bitti" diyen bir health
 * yollamamış.
 */
function peerBlocking(mac: string, now: number): boolean {
  if (busyNow(mac, now)) return true;
  const sent = otaSent.get(mac);
  if (sent === undefined || now - sent >= OTA_ZONE_COOLDOWN_MS) return false;
  const h = health.get(mac);
  const finished = !!h && h.at > sent + HEALTH_AFTER_SEND_MS && !isBusy(h.ota);
  return !finished;
}

export type OtaBlock =
  | { reason: "busy" }
  | { reason: "zone-busy"; peer: string; retryAfterSec: number };

/**
 * OTA isteği şimdi gönderilebilir mi? `peers` = aynı bölgedeki diğer cihazlar.
 * Engel yoksa null.
 */
export function otaBlockReason(mac: string, peers: string[], now = Date.now()): OtaBlock | null {
  if (busyNow(mac, now)) return { reason: "busy" };
  for (const peer of peers) {
    if (peer === mac || !peerBlocking(peer, now)) continue;
    const sent = otaSent.get(peer);
    const retryAfterSec = sent
      ? Math.max(30, Math.ceil((sent + OTA_ZONE_COOLDOWN_MS - now) / 1000))
      : 60;
    return { reason: "zone-busy", peer, retryAfterSec };
  }
  return null;
}
