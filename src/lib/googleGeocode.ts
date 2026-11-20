import "server-only";
import { googleRoutesKey } from "@/lib/mapUsage";

/**
 * Google Geocoding API istemcisi — yol tarifinde adres başlangıcı.
 *
 * Yalnızca SUNUCUDAN (`POST /api/map/geocode`), Routes ile aynı sunucu
 * anahtarıyla (`GOOGLE_ROUTES_API_KEY`; API kısıtlamasında Geocoding açık).
 * Kota `claimGoogleUsage("geocode")`. Sonuçlar hedef direğin çevresine
 * (±~30 km) öncelik verir, Türkiye dışı sonuç dönmez.
 *
 * Google kuralı: sonuç yalnızca Google haritasıyla birlikte gösterilir;
 * istemci OpenStreetMap'teyken bu uç çağrılmaz.
 */

const ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;
/** Öncelik kutusunun yarı genişliği (derece, ~30 km). */
const BIAS_DEG = 0.3;

export interface GeocodeCandidate {
  label: string;
  lat: number;
  lng: number;
}

export type GeocodeOutcome = { ok: true; results: GeocodeCandidate[] } | { ok: false; error: "failed" };

// ── Önbellek: aynı arama 10 dk içinde tekrar kota yemez ──
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; results: GeocodeCandidate[] }>();

function cacheKey(text: string, near: { lat: number; lng: number }): string {
  // Yakınlık kutusu kabaca aynıysa aynı sonuç.
  return `${text.trim().toLocaleLowerCase("tr")}|${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
}

export function cachedGeocode(text: string, near: { lat: number; lng: number }): GeocodeCandidate[] | null {
  const k = cacheKey(text, near);
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return hit.results;
}

function remember(text: string, near: { lat: number; lng: number }, results: GeocodeCandidate[]) {
  const k = cacheKey(text, near);
  cache.delete(k);
  cache.set(k, { at: Date.now(), results });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Yol tarifine başlangıç olamayacak kadar kaba sonuçlar. `components=country:TR`
 * tanınmayan metinde ülkenin kendisini ("Türkiye") döndürür.
 */
const TOO_COARSE = new Set(["country", "administrative_area_level_1"]);

interface ApiResult {
  types?: string[];
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
}

export async function geocodeAddress(text: string, near: { lat: number; lng: number }): Promise<GeocodeOutcome> {
  const key = googleRoutesKey();
  if (!key) return { ok: false, error: "failed" };

  const p = new URLSearchParams({
    address: text,
    key,
    language: "tr",
    region: "tr",
    components: "country:TR",
    bounds: `${near.lat - BIAS_DEG},${near.lng - BIAS_DEG}|${near.lat + BIAS_DEG},${near.lng + BIAS_DEG}`,
  });

  let json: { status?: string; error_message?: string; results?: ApiResult[] } | null;
  try {
    const res = await fetch(`${ENDPOINT}?${p.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    console.warn("[googleGeocode] istek başarısız:", err);
    return { ok: false, error: "failed" };
  }

  const status = json?.status;
  if (status === "ZERO_RESULTS") {
    remember(text, near, []);
    return { ok: true, results: [] };
  }
  if (status !== "OK") {
    // Anahtar metni log'a düşmesin: yalnızca durum + Google'ın mesajı.
    console.warn(`[googleGeocode] ${status ?? "yanıt yok"}:`, json?.error_message ?? "");
    return { ok: false, error: "failed" };
  }

  const results: GeocodeCandidate[] = [];
  for (const r of json?.results ?? []) {
    const lat = r.geometry?.location?.lat;
    const lng = r.geometry?.location?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    if ((r.types ?? []).some((t) => TOO_COARSE.has(t))) continue;
    results.push({ label: r.formatted_address?.trim() || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng });
    if (results.length >= MAX_RESULTS) break;
  }
  remember(text, near, results);
  return { ok: true, results };
}
