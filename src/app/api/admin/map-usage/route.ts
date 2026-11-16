import { ok } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { mapUsageSnapshot } from "@/lib/mapUsage";

export const runtime = "nodejs";

/** GET /api/admin/map-usage — Google Maps kullanım sayacı (bugün / bu ay / sınırlar). */
export async function GET(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  return ok(await mapUsageSnapshot());
}
