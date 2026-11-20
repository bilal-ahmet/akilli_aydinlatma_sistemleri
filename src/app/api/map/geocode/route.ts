import { z } from "zod";
import { ok, fail } from "@/lib/api/respond";
import { authorizePole, authorizeUser } from "@/lib/auth/guard";
import { claimGoogleUsage, googleRoutesConfigured } from "@/lib/mapUsage";
import { cachedGeocode, geocodeAddress } from "@/lib/googleGeocode";
import { inTurkey } from "@/app/_lib/poles";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Hedef direk: sonuçlar onun çevresine öncelik verir. */
  poleId: z.string().uuid(),
  text: z.string().trim().min(3).max(200),
});

// ── Kullanıcı başına hız sınırı (bellek içi): 10 dk'da 20 Google isteği ──
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
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
 * POST /api/map/geocode — yol tarifi için adres bulma (Google Geocoding,
 * sunucudan). Body: `{ poleId, text }`. Yanıt `{ provider: "google",
 * results: [{label, lat, lng}] }` (en fazla 5, Türkiye içi) ya da çözülemezse
 * hata değil `{ provider: "none", reason }` — istemci adresi doğrudan
 * `/api/map/route`'a verir (Routes kendisi çözer). İstemci OpenStreetMap
 * haritasındayken çağrılmaz.
 */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const user = await authorizeUser(req);
    if (user instanceof Response) return user;
    return fail("Geçersiz istek", 422, parsed.error.flatten());
  }
  const ctx = await authorizePole(req, parsed.data.poleId, "read");
  if (ctx instanceof Response) return ctx;
  const { lat, lng } = ctx.row;
  if (lat === null || lng === null) return fail("Direğin konumu girilmemiş", 422);
  const near = { lat, lng };
  const text = parsed.data.text;

  const cached = cachedGeocode(text, near);
  if (cached) return ok({ provider: "google", results: cached });
  if (!googleRoutesConfigured()) return ok({ provider: "none", reason: "unconfigured" });
  if (rateLimited(ctx.user.id)) return ok({ provider: "none", reason: "rate_limited" });
  if (!(await claimGoogleUsage("geocode"))) return ok({ provider: "none", reason: "quota" });

  const out = await geocodeAddress(text, near);
  if (!out.ok) return ok({ provider: "none", reason: "failed" });
  return ok({ provider: "google", results: out.results.filter((r) => inTurkey(r.lat, r.lng)) });
}
