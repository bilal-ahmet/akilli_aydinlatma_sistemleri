import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// DELETE /api/devices/:deviceId — cihazı ve ona bağlı tüm kayıtları sil.
// Lamba ve telemetri satırları da temizlenir; aksi halde aynı MAC yeniden
// eklendiğinde eski lambalar ve D4i geçmişi geri gelir (hepsi device_id ile
// mantıksal bağlı, FK yok).
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
      await tx
        .delete(schema.d4iTelemetry)
        .where(eq(schema.d4iTelemetry.deviceId, deviceId));
      await tx.delete(schema.fixtures).where(eq(schema.fixtures.deviceId, deviceId));
      await tx.delete(schema.devices).where(eq(schema.devices.deviceId, deviceId));
    });
    return ok({ deleted: deviceId });
  } catch (err) {
    return fail("Cihaz silinemedi", 500, String(err));
  }
}
