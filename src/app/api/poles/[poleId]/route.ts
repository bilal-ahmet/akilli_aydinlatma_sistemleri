import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail, msg } from "@/lib/api/respond";
import { poleUpdateSchema } from "@/types/lighting";
import { authorizePole } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import {
  listPoles,
  poleCodeTaken,
  resolveCustomerZone,
  setPoleDevice,
  type LinkError,
} from "@/lib/poleStore";

export const runtime = "nodejs";

type Params = { params: Promise<{ poleId: string }> };

class LinkFailure extends Error {
  constructor(public readonly error: LinkError) {
    super(error.technical);
  }
}

// GET /api/poles/:poleId
export async function GET(req: Request, { params }: Params) {
  const { poleId } = await params;
  const ctx = await authorizePole(req, poleId, "read");
  if (ctx instanceof Response) return ctx;
  const [view] = await listPoles(ctx.customer.id, { poleId });
  return view ? ok(view) : fail("Direk bulunamadı", 404);
}

/**
 * PATCH /api/poles/:poleId — numara, ad, not, konum, bölge ve bağlı cihaz.
 *
 * Konum: `lat` + `lng` birlikte; ikisi de null → konum silinir. Kaynak
 * verilmezse "manual" sayılır (harita "map", mobil GPS "gps" gönderir).
 *
 * Bölge değişince bağlı cihaz direkle gitmez (cihazın bölgesi firmware'deki
 * ZONE_SLUG'a bağlı): cihaz bağlıyken bölge değişikliği reddedilir, aynı
 * istekte `deviceMac: ""` ile bağ kaldırılırsa kabul edilir.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { poleId } = await params;
  const ctx = await authorizePole(req, poleId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = poleUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }
  const d = parsed.data;
  const row = ctx.row;

  const patch: Partial<typeof schema.poles.$inferInsert> = { updatedAt: new Date() };
  if (d.code !== undefined && d.code !== row.code) {
    if (await poleCodeTaken(ctx.customer.id, d.code, row.id)) {
      return fail("Bu direk numarası zaten kullanılıyor", 409);
    }
    patch.code = d.code;
  }
  if (d.name !== undefined) patch.name = d.name || null;
  if (d.notes !== undefined) patch.notes = d.notes || null;
  if (d.lat !== undefined && d.lng !== undefined) {
    const has = d.lat !== null && d.lng !== null;
    patch.lat = has ? d.lat : null;
    patch.lng = has ? d.lng : null;
    patch.locationSource = has ? (d.locationSource ?? "manual") : null;
    patch.locationAccuracyM = has ? (d.locationAccuracyM ?? null) : null;
  }

  let zoneId = row.zoneId;
  if (d.zoneSlug !== undefined) {
    const z = await resolveCustomerZone(ctx.customer.id, d.zoneSlug);
    if (!z) return fail("Bölge bulunamadı", 404);
    if (z !== row.zoneId) {
      const [linked] = await db
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(eq(schema.devices.poleId, row.id))
        .limit(1);
      if (linked && d.deviceMac !== "") {
        return fail(
          "Direğe bağlı bir cihaz var. Bölgeyi değiştirmek için önce cihazı direkten kaldırın.",
          422,
        );
      }
      zoneId = z;
      patch.zoneId = z;
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.poles).set(patch).where(eq(schema.poles.id, row.id));
      if (d.deviceMac !== undefined) {
        const err = await setPoleDevice(tx, { id: row.id, zoneId }, ctx.customer.id, d.deviceMac || null);
        if (err) throw new LinkFailure(err);
      }
    });
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "pole.update",
      target: patch.code ?? row.code,
      detail: d,
    });
    const [view] = await listPoles(ctx.customer.id, { poleId: row.id });
    return view ? ok(view) : fail("Direk bulunamadı", 404);
  } catch (err) {
    if (err instanceof LinkFailure) {
      return fail(msg(ctx.user, err.error.technical, err.error.plain), err.error.status);
    }
    return fail("Direk güncellenemedi", 500, String(err));
  }
}

// DELETE /api/poles/:poleId — direği siler; bağlı cihaz kalır (bağı NULL'lanır, FK).
export async function DELETE(req: Request, { params }: Params) {
  const { poleId } = await params;
  const ctx = await authorizePole(req, poleId, "write");
  if (ctx instanceof Response) return ctx;
  try {
    await db.delete(schema.poles).where(eq(schema.poles.id, ctx.row.id));
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "pole.delete",
      target: ctx.row.code,
    });
    return ok({ deleted: ctx.row.id });
  } catch (err) {
    return fail("Direk silinemedi", 500, String(err));
  }
}
