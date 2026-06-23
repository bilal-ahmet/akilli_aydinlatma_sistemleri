import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// DELETE /api/devices/:deviceId — cihazı ve durum kayıtlarını sil.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  const [device] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, deviceId))
    .limit(1);
  if (!device) return fail("Cihaz bulunamadı", 404);

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.deviceStatus)
        .where(eq(schema.deviceStatus.deviceId, deviceId));
      await tx.delete(schema.devices).where(eq(schema.devices.deviceId, deviceId));
    });
    return ok({ deleted: deviceId });
  } catch (err) {
    return fail("Cihaz silinemedi", 500, String(err));
  }
}
