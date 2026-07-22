import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toFaultEvent } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

/** Tek istekte dönen en fazla arıza kaydı (yeniden eskiye). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * GET /api/devices/:deviceId/faults → cihazın arıza geçmişi, yeniden eskiye.
 * Süren arızalar (`resolvedAt: null`) de listede döner; ayrı sorgu gerekmez.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const raw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    const rows = await db
      .select()
      .from(schema.faultEvents)
      .where(eq(schema.faultEvents.deviceId, deviceId))
      .orderBy(desc(schema.faultEvents.startedAt))
      .limit(limit);
    return ok(rows.map(toFaultEvent));
  } catch (err) {
    return fail("Arıza geçmişi okunamadı", 500, String(err));
  }
}
