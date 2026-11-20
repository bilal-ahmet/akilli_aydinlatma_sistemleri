import "server-only";

/**
 * Google Routes API (Compute Routes) istemcisi — direğe yol tarifi.
 *
 * Yalnızca SUNUCUDAN çağrılır (`POST /api/map/route`): anahtar
 * `GOOGLE_ROUTES_API_KEY` (yalnızca Routes API'ye kısıtlı sunucu anahtarı),
 * kota `lib/mapUsage.ts → claimGoogleUsage("route")`.
 *
 * Maliyet: alan maskesi ve `TRAFFIC_UNAWARE` isteği en ucuz SKU'da (Compute
 * Routes Essentials) tutar. Trafik bilgisi, ara durak > 10 ya da rota
 * değiştiricileri Pro SKU'suna çıkarır — eklemeyin. Adres başlangıcını Routes
 * API kendisi çözer; ayrı Geocoding isteği (ayrı fatura) yapılmaz.
 *
 * Google kuralı: Routes sonucu yalnızca Google haritası üzerinde gösterilir.
 * İstemci OpenStreetMap'teyken bu uç çağrılmaz.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.polyline.encodedPolyline",
  "routes.legs.startLocation",
  "routes.legs.endLocation",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.navigationInstruction",
].join(",");
const TIMEOUT_MS = 8000;

export type RouteMode = "drive" | "walk";
export type LatLng = { lat: number; lng: number };
export type RouteOrigin = { kind: "point"; lat: number; lng: number } | { kind: "address"; text: string };

export interface RouteStep {
  text: string;
  distanceMeters: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationS: number;
  /** Google encoded polyline (istemci `_lib/polyline.ts` ile çözer). */
  polyline: string;
  start: LatLng;
  end: LatLng;
  steps: RouteStep[];
}

export type RouteOutcome = { ok: true; route: RouteResult } | { ok: false; error: "not_found" | "failed" };

// ── Önbellek: aynı rota 10 dk içinde tekrar istenirse kota yenmez ──

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; route: RouteResult }>();

const r5 = (n: number) => n.toFixed(5);

export function routeCacheKey(origin: RouteOrigin, dest: LatLng, mode: RouteMode): string {
  const o =
    origin.kind === "point" ? `p:${r5(origin.lat)},${r5(origin.lng)}` : `a:${origin.text.trim().toLowerCase()}`;
  return `${mode}|${o}|${r5(dest.lat)},${r5(dest.lng)}`;
}

export function cachedRoute(key: string): RouteResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.route;
}

function remember(key: string, route: RouteResult) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), route });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ── İstek ──

interface ApiLatLng {
  latLng?: { latitude?: number; longitude?: number };
}
interface ApiRoute {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  legs?: Array<{
    startLocation?: ApiLatLng;
    endLocation?: ApiLatLng;
    steps?: Array<{ distanceMeters?: number; navigationInstruction?: { instructions?: string } }>;
  }>;
}

function toLatLng(p: ApiLatLng | undefined): LatLng | null {
  const lat = p?.latLng?.latitude;
  const lng = p?.latLng?.longitude;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

/** "754s" → 754 */
function parseDuration(d: string | undefined): number {
  const n = d ? Number.parseFloat(d) : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export async function computeRoute(origin: RouteOrigin, dest: LatLng, mode: RouteMode): Promise<RouteOutcome> {
  const key = process.env.GOOGLE_ROUTES_API_KEY?.trim();
  if (!key) return { ok: false, error: "failed" };

  const body = {
    origin:
      origin.kind === "point"
        ? { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } }
        : { address: origin.text },
    destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
    travelMode: mode === "walk" ? "WALK" : "DRIVE",
    ...(mode === "drive" ? { routingPreference: "TRAFFIC_UNAWARE" } : {}),
    languageCode: "tr",
    regionCode: "tr",
    units: "METRIC",
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    console.warn("[googleRoutes] istek başarısız:", err);
    return { ok: false, error: "failed" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Çözülemeyen adres 400 INVALID_ARGUMENT / NOT_FOUND olarak döner.
    if (origin.kind === "address" && (res.status === 400 || res.status === 404)) {
      return { ok: false, error: "not_found" };
    }
    console.warn(`[googleRoutes] HTTP ${res.status}:`, text.slice(0, 500));
    return { ok: false, error: "failed" };
  }

  const json = (await res.json().catch(() => null)) as { routes?: ApiRoute[] } | null;
  const r = json?.routes?.[0];
  const polyline = r?.polyline?.encodedPolyline;
  const leg = r?.legs?.[0];
  if (!r || !polyline) return { ok: false, error: "not_found" };

  const start =
    toLatLng(leg?.startLocation) ?? (origin.kind === "point" ? { lat: origin.lat, lng: origin.lng } : null);
  const end = toLatLng(leg?.endLocation) ?? dest;
  if (!start) return { ok: false, error: "not_found" };

  const route: RouteResult = {
    distanceMeters: r.distanceMeters ?? 0,
    durationS: parseDuration(r.duration),
    polyline,
    start,
    end,
    steps: (leg?.steps ?? [])
      .map((s) => ({
        text: s.navigationInstruction?.instructions?.trim() ?? "",
        distanceMeters: s.distanceMeters ?? 0,
      }))
      .filter((s) => s.text),
  };
  return { ok: true, route };
}

/** Önbellekli yol: önbellekte varsa döner, yoksa `claim` hak verirse ister. */
export async function routeWithCache(
  origin: RouteOrigin,
  dest: LatLng,
  mode: RouteMode,
  claim: () => Promise<boolean>,
): Promise<RouteOutcome | "quota"> {
  const k = routeCacheKey(origin, dest, mode);
  const hit = cachedRoute(k);
  if (hit) return { ok: true, route: hit };
  if (!(await claim())) return "quota";
  const out = await computeRoute(origin, dest, mode);
  if (out.ok) remember(k, out.route);
  return out;
}
