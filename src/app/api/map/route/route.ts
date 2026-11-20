import { z } from "zod";
import { ok, fail, msg } from "@/lib/api/respond";
import { authorizePole, authorizeUser } from "@/lib/auth/guard";
import { getPoleWithOwner } from "@/lib/poleStore";
import { claimGoogleUsage, googleRoutesConfigured } from "@/lib/mapUsage";
import { routeWithCache, type RouteOrigin } from "@/lib/googleRoutes";
import { inTurkey } from "@/app/_lib/poles";

export const runtime = "nodejs";

const UUID = z.string().uuid();

const bodySchema = z.object({
  poleId: UUID,
  mode: z.enum(["drive", "walk"]).default("drive"),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("point"), lat: z.number().finite(), lng: z.number().finite() }),
    z.object({ kind: z.literal("pole"), poleId: UUID }),
    z.object({ kind: z.literal("address"), text: z.string().trim().min(3).max(200) }),
  ]),
});

// ── Kullanıcı başına hız sınırı (bellek içi): 10 dk'da 20 Google isteği ──
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const list = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) {
    hits.set(userId, list);
    return true;
  }
  list.push(now);
  hits.set(userId, list);
  return false;
}

/**
 * POST /api/map/route — direğe yol tarifi (Google Routes API, sunucudan).
 *
 * Body: `{ poleId, mode: "drive"|"walk", origin: {kind:"point",lat,lng} |
 * {kind:"pole",poleId} | {kind:"address",text} }`.
 *
 * Çizilemeyen durumlar (yapılandırılmamış, kota dolu, hız sınırı, Google
 * hatası) hata değil 200 `{ provider: "none", reason }` döner: istemci dış
 * "Google Haritalar'da aç" bağlantısına düşer (harita oturumuyla aynı yumuşak
 * davranış). İstemci OpenStreetMap haritasındayken bu uç çağrılmaz — Google
 * rotası yalnızca Google haritasında gösterilebilir.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    // Bozuk gövdede de önce oturum kontrolü.
    const user = await authorizeUser(req);
    if (user instanceof Response) return user;
    return fail("Geçersiz istek", 422, parsed.error.flatten());
  }
  const ctx = await authorizePole(req, parsed.data.poleId, "read");
  if (ctx instanceof Response) return ctx;
  const { mode, origin } = parsed.data;
  const user = ctx.user;

  const dest = ctx.row;
  if (dest.lat === null || dest.lng === null) {
    return fail("Direğin konumu girilmemiş", 422);
  }

  let from: RouteOrigin;
  if (origin.kind === "pole") {
    const hit = await getPoleWithOwner(origin.poleId);
    if (!hit || hit.customerId !== ctx.customer.id) return fail("Başlangıç direği bulunamadı", 404);
    if (hit.row.lat === null || hit.row.lng === null) {
      return fail("Başlangıç direğinin konumu girilmemiş", 422);
    }
    from = { kind: "point", lat: hit.row.lat, lng: hit.row.lng };
  } else if (origin.kind === "point") {
    if (!inTurkey(origin.lat, origin.lng)) {
      return fail(
        msg(user, "Başlangıç noktası Türkiye sınırları dışında", "Başlangıç noktası hizmet alanının dışında"),
        422,
      );
    }
    from = origin;
  } else {
    from = origin;
  }

  if (!googleRoutesConfigured()) return ok({ provider: "none", reason: "unconfigured" });
  if (rateLimited(user.id)) return ok({ provider: "none", reason: "rate_limited" });

  const out = await routeWithCache(from, { lat: dest.lat, lng: dest.lng }, mode, () =>
    claimGoogleUsage("route"),
  );
  if (out === "quota") return ok({ provider: "none", reason: "quota" });
  if (!out.ok) {
    if (out.error === "not_found") {
      return fail(
        origin.kind === "address" ? "Adres bulunamadı ya da bu adresten rota çıkmadı" : "Bu noktalar arasında rota bulunamadı",
        404,
      );
    }
    return ok({ provider: "none", reason: "failed" });
  }
  return ok({ provider: "google", route: out.route });
}
