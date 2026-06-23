import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// GET /api/devices/:deviceId/status — cihazın son durumu (device_status).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const [last] = await db
    .select()
    .from(schema.deviceStatus)
    .where(eq(schema.deviceStatus.deviceId, deviceId))
    .orderBy(desc(schema.deviceStatus.recordedAt))
    .limit(1);

  if (!last) return fail("Cihaz için durum kaydı yok", 404);
  return ok(last);
}
