import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { zoneUpdateSchema } from "@/types/lighting";

export const runtime = "nodejs";

// PATCH /api/zones/:zoneId — zone alanlarını güncelle (isim, ilçe, direk, durum, ...).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;
  const parsed = zoneUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }

  const [row] = await db
    .update(schema.zones)
    .set(parsed.data)
    .where(eq(schema.zones.slug, zoneId))
    .returning();

  if (!row) return fail("Zone bulunamadı", 404);
  return ok(toZone(row));
}

// DELETE /api/zones/:zoneId — zone'u ve ona bağlı cihazları/durum kayıtlarını sil.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;

  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneId))
    .limit(1);
  if (!zone) return fail("Zone bulunamadı", 404);

  try {
    await db.transaction(async (tx) => {
      // Zone'a bağlı cihazların id'lerini al → onların status loglarını ve
      // komutlarını temizle, sonra cihazları ve zone'u sil (FK sırası).
      const devs = await tx
        .select({ deviceId: schema.devices.deviceId })
        .from(schema.devices)
        .where(eq(schema.devices.zoneId, zone.id));
      const deviceIds = devs.map((d) => d.deviceId);

      if (deviceIds.length > 0) {
        await tx
          .delete(schema.deviceStatus)
          .where(inArray(schema.deviceStatus.deviceId, deviceIds));
        await tx
          .delete(schema.devices)
          .where(eq(schema.devices.zoneId, zone.id));
      }
      await tx.delete(schema.zones).where(eq(schema.zones.id, zone.id));
    });
    return ok({ deleted: zoneId });
  } catch (err) {
    return fail("Zone silinemedi", 500, String(err));
  }
}
