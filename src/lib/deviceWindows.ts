/**
 * Cihaz başına zaman pencereleri — saf, sunucu ve istemci kullanabilir.
 *
 * Firmware rapor aralıklarını yalnızca ilk kayıtta (join) health'te bildirir
 * (`health_interval_s`, `report_interval_s`, saniye; binary 0xB9 / 0xBA) ve
 * backend bunları `devices.*_interval_s`'te tutar. Bildirmeyen cihaz (eski
 * firmware) ~30 sn'de bir gönderir; onun için eski sabit pencereler geçerlidir.
 *
 * 2,5 kat: iki raporu kaçırmaya tolerans. Sabitler alt sınırdır — sık rapor
 * veren cihazda davranış değişmez.
 */

/** Aralık bildirmeyen cihazın "çevrimiçi" penceresi (eski sabit). */
export const DEFAULT_ONLINE_WINDOW_MS = 3 * 60_000;
/** Aralık bildirmeyen cihazın ölçüm tazelik penceresi (eski sabit). */
export const DEFAULT_FRESH_MS = 10 * 60_000;
/** Kaç rapor aralığı sessizlik "bağlantı yok" sayılır. */
export const MISSED_REPORTS = 2.5;

/** Geçerli bir aralık mı (1 sn – 1 gün, tam sayı)? Değilse undefined. */
export function intervalSeconds(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 86_400 ? v : undefined;
}

export interface DeviceIntervals {
  healthIntervalS: number | null;
  reportIntervalS: number | null;
}

/**
 * `last_seen` her mesajla (health, rapor, ack) tazelenir; bu yüzden en SIK
 * gelen mesajın aralığına bakılır.
 */
export function onlineWindowMs(d: DeviceIntervals): number {
  const known = [d.healthIntervalS, d.reportIntervalS].filter((v): v is number => v != null && v > 0);
  if (known.length === 0) return DEFAULT_ONLINE_WINDOW_MS;
  return Math.max(DEFAULT_ONLINE_WINDOW_MS, MISSED_REPORTS * Math.min(...known) * 1000);
}

/** Lambanın son D4i raporu bu süre içindeyse güç/gerilim özetine girer. */
export function freshMs(d: Pick<DeviceIntervals, "reportIntervalS">): number {
  const r = d.reportIntervalS;
  if (r == null || r <= 0) return DEFAULT_FRESH_MS;
  return Math.max(DEFAULT_FRESH_MS, MISSED_REPORTS * r * 1000);
}
