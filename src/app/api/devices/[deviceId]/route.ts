import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { deviceUpdateSchema } from "@/types/lighting";
import { authorizeDevice } from "@/lib/auth/guard";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

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
 *
 * Başka MÜŞTERİNİN bölgesine taşıma reddedilir (admin için de): cihaz eski
 * ZONE_SLUG'ı dinlemeye devam edeceği için eski müşterinin bölge komutlarını
 * almayı sürdürürdü. Müşteri değişimi bölge seviyesinde (admin, bölge taşıma)
 * ya da yeniden flaşlayıp sil/ekle ile yapılır.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = deviceUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }
  const { zoneSlug, name } = parsed.data;

  const patch: { zoneId?: string; name?: string | null } = {};

  if (zoneSlug !== undefined) {
    const [zone] = await db
      .select({ id: schema.zones.id, customerId: schema.zones.customerId })
      .from(schema.zones)
      .where(eq(schema.zones.slug, zoneSlug))
      .limit(1);
    // Müşteri, başka müşterinin bölgesini "bulunamadı" olarak görür.
    if (!zone || (ctx.user.role !== "admin" && zone.customerId !== ctx.customerId)) {
      return fail("Bölge bulunamadı", 404);
    }
    if (ctx.customerId && zone.customerId !== ctx.customerId) {
      return fail(
        "Cihaz başka bir müşterinin bölgesine taşınamaz (cihaz eski bölge topic'ini dinlemeye devam eder). Bölgeyi taşıyın ya da cihazı yeniden flaşlayıp sil/ekle yapın.",
        422,
      );
    }
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

    if (patch.zoneId) await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customerId,
      action: "device.update",
      target: deviceId,
      detail: parsed.data,
    });

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
// Lamba, telemetri ve arıza satırları da temizlenir; aksi halde aynı MAC
// yeniden (belki başka müşteriye) eklendiğinde eski veri geri gelir (hepsi
// device_id ile mantıksal bağlı, FK yok).
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "write");
  if (ctx instanceof Response) return ctx;

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
      await tx.delete(schema.faultEvents).where(eq(schema.faultEvents.deviceId, deviceId));
      await tx.delete(schema.fixtures).where(eq(schema.fixtures.deviceId, deviceId));
      await tx.delete(schema.devices).where(eq(schema.devices.deviceId, deviceId));
    });
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customerId,
      action: "device.delete",
      target: deviceId,
    });
    return ok({ deleted: deviceId });
  } catch (err) {
    return fail("Cihaz silinemedi", 500, String(err));
  }
}
