import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail, msg } from "@/lib/api/respond";
import { deviceUpdateSchema } from "@/types/lighting";
import { authorizeDevice } from "@/lib/auth/guard";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { normalizeMac } from "@/lib/mac";
import { renameDeviceMac } from "@/lib/deviceRename";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const selectShape = {
  id: schema.devices.id,
  deviceId: schema.devices.deviceId,
  name: schema.devices.name,
  lastSeen: schema.devices.lastSeen,
  lastError: schema.devices.lastError,
  lastErrorAt: schema.devices.lastErrorAt,
  firmwareVersion: schema.devices.firmwareVersion,
  health: schema.devices.health,
  healthAt: schema.devices.healthAt,
  gatewayId: schema.devices.gatewayId,
  poleId: schema.devices.poleId,
  poleCode: schema.poles.code,
  zoneSlug: schema.zones.slug,
  zoneName: schema.zones.name,
};

/**
 * PATCH /api/devices/:deviceId — cihazın bölgesini, ismini ve/veya MAC'ini
 * güncelle.
 *
 * MAC değişikliği yanlış girilmiş kodu düzeltmek içindir: cihaz ve MAC'e bağlı
 * tüm kayıtlar yeni MAC'e taşınır (`renameDeviceMac`). Yeni MAC başka bir
 * cihaz ya da gateway olarak kayıtlıysa 409 (başka müşterideyse sahip
 * açıklanmaz — oluşturma kuralıyla aynı). Komutlar bundan sonra
 * `Meven:<yeni MAC>/cmd`'ye gider; cihazın bölge topic'i değişmez.
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
 *
 * `poleId`: cihazın takılı olduğu direk (aynı bölgede, boş olmalı); "" bağı
 * kaldırır. Bölge değişip direk verilmezse eski direğin bağı kalkar.
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

  // ── MAC düzeltmesi ──
  let newMac: string | null = null;
  if (parsed.data.mac !== undefined) {
    newMac = normalizeMac(parsed.data.mac);
    if (!newMac) {
      return fail(
        msg(
          ctx.user,
          "Geçersiz MAC adresi (12 hane hex bekleniyor)",
          "Geçersiz cihaz kodu: 12 karakter olmalı (rakamlar ve A-F harfleri)",
        ),
        422,
      );
    }
    if (newMac === deviceId) newMac = null;
  }
  if (newMac) {
    const taken = msg(
      ctx.user,
      "Bu MAC adresi başka bir hesapta kayıtlı. Yöneticinize başvurun.",
      "Bu cihaz kodu başka bir hesapta kayıtlı. Yöneticinize başvurun.",
    );
    const idx = await getTenancy();
    const gwOwner = idx.gatewayOwner.get(newMac);
    if (gwOwner) {
      return fail(
        gwOwner === ctx.customerId
          ? msg(ctx.user, "Bu MAC bir gateway olarak kayıtlı", "Bu kod bir ağ geçidi olarak kayıtlı")
          : taken,
        409,
      );
    }
    const [dup] = await db
      .select({ id: schema.devices.id })
      .from(schema.devices)
      .where(eq(schema.devices.deviceId, newMac))
      .limit(1);
    if (dup) {
      const own = idx.deviceOwner.get(newMac);
      if (own && own === ctx.customerId) {
        return fail(msg(ctx.user, "Bu MAC adresi başka bir cihazda kayıtlı", "Bu cihaz kodu başka bir cihazda kayıtlı"), 409);
      }
      await audit({
        req,
        user: ctx.user,
        customerId: ctx.customerId,
        action: "device.mac_conflict",
        target: newMac,
      });
      return fail(taken, 409);
    }
  }

  const patch: { zoneId?: string; name?: string | null; poleId?: string | null } = {};

  const [current] = await db
    .select({ zoneId: schema.devices.zoneId, poleId: schema.devices.poleId })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, deviceId))
    .limit(1);
  if (!current) return fail("Cihaz bulunamadı", 404);

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

  // ── Direk ── Cihaz ile direk aynı bölgede olmalı (lib/poleStore.ts). Bölge
  // değişip yeni direk verilmediyse eski direğin bağı kaldırılır.
  const targetZone = patch.zoneId ?? current.zoneId;
  const { poleId } = parsed.data;
  if (poleId !== undefined && poleId !== "") {
    const [pole] = await db
      .select({ zoneId: schema.poles.zoneId, holder: schema.devices.deviceId })
      .from(schema.poles)
      .leftJoin(schema.devices, eq(schema.devices.poleId, schema.poles.id))
      .where(eq(schema.poles.id, poleId))
      .limit(1);
    if (!pole || pole.zoneId !== targetZone) {
      return fail(
        "Direk bulunamadı ya da cihazla aynı bölgede değil",
        pole ? 422 : 404,
      );
    }
    if (pole.holder && pole.holder !== deviceId) {
      return fail(msg(ctx.user, `Bu direkte başka bir cihaz var (${pole.holder})`, "Bu direkte başka bir cihaz var"), 409);
    }
    patch.poleId = poleId;
  } else if (poleId === "") {
    patch.poleId = null;
  } else if (patch.zoneId && patch.zoneId !== current.zoneId && current.poleId) {
    patch.poleId = null;
  }

  try {
    // Yalnızca MAC değişiyorsa güncellenecek kayıt alanı yok; varlık kontrolü yeter.
    const [updated] =
      Object.keys(patch).length > 0
        ? await db
            .update(schema.devices)
            .set(patch)
            .where(eq(schema.devices.deviceId, deviceId))
            .returning({ id: schema.devices.id })
        : await db
            .select({ id: schema.devices.id })
            .from(schema.devices)
            .where(eq(schema.devices.deviceId, deviceId))
            .limit(1);
    if (!updated) return fail("Cihaz bulunamadı", 404);

    if (newMac) await renameDeviceMac(deviceId, newMac, ctx.customerId);
    if (patch.zoneId || newMac) await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customerId,
      action: newMac ? "device.mac_change" : "device.update",
      target: deviceId,
      detail: newMac ? { ...parsed.data, from: deviceId, to: newMac } : parsed.data,
    });

    // Bölge adını da döndürmek için join'li satırı yeniden oku.
    const [row] = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .leftJoin(schema.poles, eq(schema.devices.poleId, schema.poles.id))
      .where(eq(schema.devices.deviceId, newMac ?? deviceId))
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
