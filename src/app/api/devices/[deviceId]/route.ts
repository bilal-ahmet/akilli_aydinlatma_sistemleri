import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { deviceUpdateSchema } from "@/types/lighting";

export const runtime = "nodejs";

const selectShape = {
  id: schema.devices.id,
  deviceId: schema.devices.deviceId,
  name: schema.devices.name,
  lastSeen: schema.devices.lastSeen,
  lastError: schema.devices.lastError,
  lastErrorAt: schema.devices.lastErrorAt,
  zoneSlug: schema.zones.slug,
  zoneName: schema.zones.name,
};

/**
 * PATCH /api/devices/:deviceId — cihazın bölgesini ve/veya ismini güncelle.
 *
 * Bölge değişikliği DASHBOARD KAYDINI taşır; cihazın dinlediği bölge topic'i
 * (`Meven:<slug>/cmd`) firmware'deki ZONE_SLUG'tan gelir. Cihaz yeniden
 * flaşlanana kadar eski bölgenin toplu komutlarını almaya devam eder, yeni
 * bölgeninkileri almaz. Tekil (MAC) ve "tüm sistem" komutları etkilenmez.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  const parsed = deviceUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }
  const { zoneSlug, name } = parsed.data;

  const patch: { zoneId?: string; name?: string | null } = {};

  if (zoneSlug !== undefined) {
    const [zone] = await db
      .select({ id: schema.zones.id })
      .from(schema.zones)
      .where(eq(schema.zones.slug, zoneSlug))
      .limit(1);
    if (!zone) return fail("Bölge bulunamadı", 404);
    patch.zoneId = zone.id;
  }
  if (name !== undefined) patch.name = name || null;

  try {
    const [updated] = await db
      .update(schema.devices)
      .set(patch)
      .where(eq(schema.devices.deviceId, deviceId))
      .returning({ id: schema.devices.id });
    if (!updated) return fail("Cihaz bulunamadı", 404);

    // Bölge adını da döndürmek için join'li satırı yeniden oku.
    const [row] = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(eq(schema.devices.deviceId, deviceId))
      .limit(1);
    return ok(toDeviceView(row));
  } catch (err) {
    return fail("Cihaz güncellenemedi", 500, String(err));
  }
}

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
