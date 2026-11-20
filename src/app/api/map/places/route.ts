import { z } from "zod";
import { ok, fail } from "@/lib/api/respond";
import { authorizePole, authorizeUser } from "@/lib/auth/guard";
import { claimGoogleUsage, googleRoutesConfigured } from "@/lib/mapUsage";
import { autocomplete, cachedSuggestions, placeLocation, placesDisabled } from "@/lib/googlePlaces";
import { inTurkey } from "@/app/_lib/poles";

export const runtime = "nodejs";

const token = z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("suggest"),
    poleId: z.string().uuid(),
    input: z.string().trim().min(3).max(120),
    sessionToken: token,
  }),
  z.object({
    action: z.literal("details"),
    poleId: z.string().uuid(),
    placeId: z.string().min(1).max(300),
    sessionToken: token,
  }),
]);

// ── Kullanıcı başına hız sınırı (bellek içi): yazarken istek sık, 10 dk'da 120 ──
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  const limited = list.length >= MAX_PER_WINDOW;
  if (!limited) list.push(now);
  hits.set(userId, list);
  return limited;
}

/**
 * POST /api/map/places — yol tarifinde adres önerisi (Google Places API (New),
 * sunucudan). İki işlem:
 *
 * - `{ action: "suggest", poleId, input, sessionToken }` →
 *   `{ provider: "google", suggestions: [{placeId, main, secondary}] }`
 * - `{ action: "details", poleId, placeId, sessionToken }` →
 *   `{ provider: "google", place: {label, lat, lng} }` (oturumu bitirir)
 *
 * Kullanılamıyorsa (anahtar yok / Places kapalı / kota / hız sınırı / hata)
 * 200 `{ provider: "none", reason }` — istemci öneri listesini kapatır, adres
 * "Rotayı göster" ile Geocoding'e gider. OpenStreetMap haritasında çağrılmaz.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const user = await authorizeUser(req);
    if (user instanceof Response) return user;
    return fail("Geçersiz istek", 422, parsed.error.flatten());
  }
  const body = parsed.data;
  const ctx = await authorizePole(req, body.poleId, "read");
  if (ctx instanceof Response) return ctx;
  const { lat, lng } = ctx.row;
  if (lat === null || lng === null) return fail("Direğin konumu girilmemiş", 422);
  const near = { lat, lng };

  if (body.action === "suggest") {
    const cached = cachedSuggestions(body.input, near);
    if (cached) return ok({ provider: "google", suggestions: cached });
  }
  if (!googleRoutesConfigured()) return ok({ provider: "none", reason: "unconfigured" });
  if (placesDisabled()) return ok({ provider: "none", reason: "disabled" });
  if (rateLimited(ctx.user.id)) return ok({ provider: "none", reason: "rate_limited" });
  if (!(await claimGoogleUsage("places"))) return ok({ provider: "none", reason: "quota" });

  if (body.action === "suggest") {
    const list = await autocomplete(body.input, near, body.sessionToken);
    if (!list) return ok({ provider: "none", reason: placesDisabled() ? "disabled" : "failed" });
    return ok({ provider: "google", suggestions: list });
  }

  const place = await placeLocation(body.placeId, body.sessionToken);
  if (!place) return ok({ provider: "none", reason: placesDisabled() ? "disabled" : "failed" });
  if (!inTurkey(place.lat, place.lng)) return fail("Seçilen yer hizmet alanının dışında", 422);
  return ok({ provider: "google", place });
}
