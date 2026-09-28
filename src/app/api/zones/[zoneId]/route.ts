import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { zoneUpdateSchema } from "@/types/lighting";
import { authorizeZone } from "@/lib/auth/guard";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * PATCH /api/zones/:zoneId — bölge alanlarını güncelle (isim, ilçe, direk, durum, ...).
 * `customerSlug` (yalnızca admin): bölgeyi cihazlarıyla başka müşteriye taşır.
 * Yanıttaki `movedTo` doluysa bölge artık istek yapılan panelin müşterisine ait değildir.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;
  const ctx = await authorizeZone(req, zoneId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = zoneUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }
  const { customerSlug, ...fields } = parsed.data;

  const patch: Partial<typeof schema.zones.$inferInsert> = { ...fields };
  let movedTo: { slug: string; name: string } | null = null;

  if (customerSlug !== undefined && customerSlug !== ctx.customer.slug) {
    if (ctx.user.role !== "admin") {
      return fail("Bölgeyi başka müşteriye yalnızca yönetici taşıyabilir", 403);
    }
    const target = (await getTenancy()).customersBySlug.get(customerSlug);
    if (!target) return fail("Hedef müşteri bulunamadı", 404);
    patch.customerId = target.id;
    movedTo = { slug: target.slug, name: target.name };
  }

  if (Object.keys(patch).length === 0) {
    const [row] = await db.select().from(schema.zones).where(eq(schema.zones.slug, zoneId)).limit(1);
    return row ? ok({ ...toZone(row), movedTo: null }) : fail("Zone bulunamadı", 404);
  }

  const [row] = await db
    .update(schema.zones)
    .set(patch)
    .where(eq(schema.zones.slug, zoneId))
    .returning();

  if (!row) return fail("Zone bulunamadı", 404);

  if (movedTo) {
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone.move",
      target: zoneId,
      detail: { from: ctx.customer.slug, to: movedTo.slug },
    });
  } else {
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone.update",
      target: zoneId,
      detail: fields,
    });
  }
  return ok({ ...toZone(row), movedTo });
}

// DELETE /api/zones/:zoneId — zone'u ve ona bağlı cihazları/durum kayıtlarını sil.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;
  const ctx = await authorizeZone(req, zoneId, "write");
  if (ctx instanceof Response) return ctx;

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
        // Lamba, D4i ve arıza kayıtları da device_id ile mantıksal bağlı (FK
        // yok) — temizlenmezse aynı MAC yeniden (belki başka müşteriye)
        // eklendiğinde eski veri geri gelir.
        await tx
          .delete(schema.d4iTelemetry)
          .where(inArray(schema.d4iTelemetry.deviceId, deviceIds));
        await tx
          .delete(schema.faultEvents)
          .where(inArray(schema.faultEvents.deviceId, deviceIds));
        await tx
          .delete(schema.fixtures)
          .where(inArray(schema.fixtures.deviceId, deviceIds));
        await tx
          .delete(schema.devices)
          .where(eq(schema.devices.zoneId, zone.id));
      }
      await tx.delete(schema.zones).where(eq(schema.zones.id, zone.id));
      // Slug bir daha verilmez: sahada bu slug ile flaşlanmış cihazlar
      // Meven:<slug>/cmd'yi dinlemeye devam eder (bkz. lib/zoneSlug.ts).
      await tx
        .insert(schema.retiredZoneSlugs)
        .values({ slug: zoneId, customerId: ctx.customer.id })
        .onConflictDoNothing();
    });
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone.delete",
      target: zoneId,
    });
    return ok({ deleted: zoneId });
  } catch (err) {
    return fail("Zone silinemedi", 500, String(err));
  }
}
