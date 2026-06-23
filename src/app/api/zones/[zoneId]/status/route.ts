import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// GET /api/zones/:zoneId/status — son bilinen zone durumu (DB snapshot).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;
  const [zone] = await db
    .select()
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneId))
    .limit(1);

  if (!zone) return fail("Zone bulunamadı", 404);
  return ok(toZone(zone));
}
