import "server-only";
import { googleRoutesKey } from "@/lib/mapUsage";

/**
 * Google Places API (New) — yol tarifinde adres önerisi (yazarken).
 *
 * Yalnızca SUNUCUDAN (`/api/map/places/*`), Routes ile aynı sunucu
 * anahtarıyla (API kısıtlamasında "Places API (New)" açık olmalı). Kota
 * `claimGoogleUsage("places")`.
 *
 * Maliyet: istemci yazma oturumu başına bir `sessionToken` üretir. Oturum
 * Place Details ile biterse o oturumdaki Autocomplete istekleri ayrıca
 * faturalanmaz; Details'te yalnızca Essentials alanları (`location`,
 * `formattedAddress`) istenir — `displayName` vb. Pro'ya çıkar, eklemeyin.
 *
 * Anahtarda Places kapalıysa (403) özellik sunucu genelinde 10 dk kapatılır:
 * kota boşa yazılmaz, istemci Geocoding akışına döner.
 */

const AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS = "https://places.googleapis.com/v1/places/";
const TIMEOUT_MS = 6000;
/** Öncelik dairesi yarıçapı (m). */
const BIAS_RADIUS_M = 30_000;
const DISABLE_MS = 10 * 60_000;

export interface PlaceSuggestion {
  placeId: string;
  main: string;
  secondary: string;
}

export interface PlaceLocation {
  label: string;
  lat: number;
  lng: number;
}

let disabledUntil = 0;

/** Anahtarda Places kapalı olduğu yakın zamanda görüldü mü? */
export function placesDisabled(): boolean {
  return Date.now() < disabledUntil;
}

function noteFailure(status: number, text: string) {
  if (status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED/.test(text)) {
    if (!placesDisabled()) {
      console.warn("[googlePlaces] Places API (New) bu anahtarda kapalı; adres önerisi 10 dk devre dışı.");
    }
    disabledUntil = Date.now() + DISABLE_MS;
    return;
  }
  console.warn(`[googlePlaces] HTTP ${status}:`, text.slice(0, 300));
}

// ── Öneri önbelleği: aynı metin 10 dk içinde tekrar kota yemez ──
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; list: PlaceSuggestion[] }>();

function cacheKey(input: string, near: { lat: number; lng: number }) {
  return `${input.trim().toLocaleLowerCase("tr")}|${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
}

export function cachedSuggestions(input: string, near: { lat: number; lng: number }): PlaceSuggestion[] | null {
  const k = cacheKey(input, near);
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return hit.list;
}

function remember(input: string, near: { lat: number; lng: number }, list: PlaceSuggestion[]) {
  const k = cacheKey(input, near);
  cache.delete(k);
  cache.set(k, { at: Date.now(), list });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

interface ApiSuggestion {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
  };
}

export async function autocomplete(
  input: string,
  near: { lat: number; lng: number },
  sessionToken: string,
): Promise<PlaceSuggestion[] | null> {
  const key = googleRoutesKey();
  if (!key) return null;
  let res: Response;
  try {
    res = await fetch(AUTOCOMPLETE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat",
      },
      body: JSON.stringify({
        input,
        sessionToken,
        languageCode: "tr",
        regionCode: "tr",
        includedRegionCodes: ["tr"],
        locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: BIAS_RADIUS_M } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[googlePlaces] öneri isteği başarısız:", err);
    return null;
  }
  if (!res.ok) {
    noteFailure(res.status, await res.text().catch(() => ""));
    return null;
  }
  const json = (await res.json().catch(() => null)) as { suggestions?: ApiSuggestion[] } | null;
  const list: PlaceSuggestion[] = [];
  for (const s of json?.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    const main = p.structuredFormat?.mainText?.text ?? p.text?.text ?? "";
    if (!main) continue;
    list.push({ placeId: p.placeId, main, secondary: p.structuredFormat?.secondaryText?.text ?? "" });
  }
  remember(input, near, list);
  return list;
}

export async function placeLocation(placeId: string, sessionToken: string): Promise<PlaceLocation | null> {
  const key = googleRoutesKey();
  if (!key) return null;
  const p = new URLSearchParams({ languageCode: "tr", regionCode: "tr", sessionToken });
  let res: Response;
  try {
    res = await fetch(`${DETAILS}${encodeURIComponent(placeId)}?${p.toString()}`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "location,formattedAddress" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[googlePlaces] ayrıntı isteği başarısız:", err);
    return null;
  }
  if (!res.ok) {
    noteFailure(res.status, await res.text().catch(() => ""));
    return null;
  }
  const json = (await res.json().catch(() => null)) as {
    location?: { latitude?: number; longitude?: number };
    formattedAddress?: string;
  } | null;
  const lat = json?.location?.latitude;
  const lng = json?.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { label: json?.formattedAddress?.trim() || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
}
