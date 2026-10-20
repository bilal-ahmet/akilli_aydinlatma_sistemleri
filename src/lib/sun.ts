/**
 * Gün doğumu / gün batımı hesabı (saf; istemci ve sunucu ortak).
 *
 * "Almanac for Computers" (1990, US Naval Observatory) algoritması — NOAA'nın
 * da kullandığı sunriset yöntemi. Resmî zenit 90.833° (kırılma + güneş
 * yarıçapı). Doğruluk ±1-2 dk; sokak aydınlatması için yeterli, kütüphane
 * gerekmez.
 *
 * Koordinat şimdilik sabit: bütün müşteriler Kocaeli'de. İleride müşteri
 * koordinatı eklenirse `sunEventUtc`'ye o verilir.
 */

export const KOCAELI = { lat: 40.7654, lon: 29.9408 } as const; // İzmit

export type SunEvent = "sunrise" | "sunset";

const ZENITH = 90.833;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const norm = (v: number, max: number) => ((v % max) + max) % max;

/**
 * Verilen takvim gününde (yerel tarih) olayın UTC anı. Kutup gecesi/günü
 * gibi olayın hiç olmadığı durumda `null` (Kocaeli'de olmaz).
 */
export function sunEventUtc(
  y: number,
  m: number,
  d: number,
  event: SunEvent,
  { lat, lon }: { lat: number; lon: number } = KOCAELI,
): Date | null {
  const dayStart = Date.UTC(y, m - 1, d);
  const n = Math.round((dayStart - Date.UTC(y, 0, 1)) / 86_400_000) + 1; // yılın günü
  const lngHour = lon / 15;
  const t = n + ((event === "sunrise" ? 6 : 18) - lngHour) / 24;

  const M = 0.9856 * t - 3.289; // ortalama anomali
  const L = norm(M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634, 360);

  let RA = norm(deg(Math.atan(0.91764 * Math.tan(rad(L)))), 360);
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; // L ile aynı çeyrek
  RA /= 15;

  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH =
    (Math.cos(rad(ZENITH)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  if (cosH > 1 || cosH < -1) return null;

  const H = (event === "sunrise" ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  // Türkiye'de (UTC+3, 30°D) olay UTC'de aynı güne düşer; gün kayması olmaz.
  const ut = norm(T - lngHour, 24);
  return new Date(dayStart + Math.round(ut * 3_600_000));
}
