import { ok } from "@/lib/api/respond";
import { authorizeUser } from "@/lib/auth/guard";
import { claimGoogleMapLoad } from "@/lib/mapUsage";

export const runtime = "nodejs";

/**
 * POST /api/map/session — istemci yeni bir Google haritası kurmadan ÖNCE sorar.
 * Kota uygunsa sayaç artırılır ve `google` döner; sınır dolmuşsa ya da Google
 * yapılandırılmamışsa `osm` (istemci MapLibre + OpenStreetMap çizer).
 * Müşteri kapsamı yok: sayaç tüm müşteriler için ortaktır.
 */
export async function POST(req: Request) {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  return ok({ provider: (await claimGoogleMapLoad()) ? "google" : "osm" });
}
