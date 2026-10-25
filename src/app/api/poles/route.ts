import { db, schema } from "@/lib/db";
import { ok, fail, msg } from "@/lib/api/respond";
import { poleCreateSchema } from "@/types/lighting";
import { authorizeScope } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import {
  listPoles,
  poleCodeTaken,
  resolveCustomerZone,
  setPoleDevice,
  type LinkError,
} from "@/lib/poleStore";

export const runtime = "nodejs";

/** Transaction'ı geri almak için fırlatılır; route bunu hata yanıtına çevirir. */
class LinkFailure extends Error {
  constructor(public readonly error: LinkError) {
    super(error.technical);
  }
}

// GET /api/poles?customer=<slug>[&zone=<slug>] — müşterinin direkleri.
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  const zoneSlug = new URL(req.url).searchParams.get("zone") ?? undefined;
  try {
    return ok(await listPoles(ctx.customer.id, { zoneSlug }));
  } catch (err) {
    return fail("Direkler okunamadı", 500, String(err));
  }
}

/**
 * POST /api/poles?customer=<slug> — yeni direk. Konum opsiyonel (sonra
 * haritadan ya da sahada GPS ile girilebilir); `deviceMac` verilirse aynı
 * bölgedeki cihaz direğe bağlanır.
 */
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = poleCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz direk verisi", 422, parsed.error.flatten());
  }
  const d = parsed.data;

  const zoneId = await resolveCustomerZone(ctx.customer.id, d.zoneSlug);
  if (!zoneId) return fail("Bölge bulunamadı", 404);
  if (await poleCodeTaken(ctx.customer.id, d.code)) {
    return fail("Bu direk numarası zaten kullanılıyor", 409);
  }

  const hasLocation = d.lat != null && d.lng != null;
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.poles)
        .values({
          zoneId,
          code: d.code,
          name: d.name || null,
          lat: hasLocation ? d.lat : null,
          lng: hasLocation ? d.lng : null,
          locationSource: hasLocation ? (d.locationSource ?? "manual") : null,
          locationAccuracyM: hasLocation ? (d.locationAccuracyM ?? null) : null,
          notes: d.notes || null,
        })
        .returning({ id: schema.poles.id });
      if (d.deviceMac) {
        const err = await setPoleDevice(tx, { id: row.id, zoneId }, ctx.customer.id, d.deviceMac);
        if (err) throw new LinkFailure(err);
      }
      return row.id;
    });
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "pole.create",
      target: d.code,
      detail: { zoneSlug: d.zoneSlug, lat: d.lat ?? null, lng: d.lng ?? null, deviceMac: d.deviceMac ?? null },
    });
    const [view] = await listPoles(ctx.customer.id, { poleId: id });
    return ok(view, { status: 201 });
  } catch (err) {
    if (err instanceof LinkFailure) {
      return fail(msg(ctx.user, err.error.technical, err.error.plain), err.error.status);
    }
    return fail("Direk oluşturulamadı", 500, String(err));
  }
}
