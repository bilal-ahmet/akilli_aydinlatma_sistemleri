import { ok } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { zoneSyncSnapshot } from "@/lib/zoneSync/engine";

export const runtime = "nodejs";

/**
 * GET /api/admin/zone-sync — dinamik bölge aboneliğinin özeti (bellek içi):
 * mod (MQTT_ZONE_SYNC), durum sayıları, senkron dışı cihazlar (istenen vs
 * cihazın bildirdiği liste) ve cihaza gönderilemeyen (kural dışı) slug'lar.
 */
export async function GET(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  await getTenancy();
  return ok(zoneSyncSnapshot());
}
