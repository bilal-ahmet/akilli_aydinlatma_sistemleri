import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail, msg } from "@/lib/api/respond";
import { gatewayCreateSchema } from "@/types/lighting";
import { normalizeMac } from "@/lib/mac";
import { authorizeScope } from "@/lib/auth/guard";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { forgetDiscoveredGateway } from "@/lib/gatewayDiscovery";
import { listGateways, resolveGatewayZone } from "@/lib/gatewayStore";

export const runtime = "nodejs";

// GET /api/gateways?customer=<slug> — müşterinin gateway'leri.
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    return ok(await listGateways(ctx.customer.id, { technical: ctx.user.role === "admin" }));
  } catch (err) {
    return fail("Ağ geçitleri okunamadı", 500, String(err));
  }
}

/**
 * POST /api/gateways?customer=<slug> — gateway kaydı (GW_ID + tür).
 *
 * GW_ID cihaz MAC'leriyle aynı topic uzayını paylaşır (Meven:<ID>/…): kimlik
 * cihaz olarak kayıtlıysa reddedilir. Başka müşteride kayıtlıysa sahibi
 * açıklanmaz (cihaz kuralıyla aynı).
 */
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;
  const technical = ctx.user.role === "admin";

  const parsed = gatewayCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz ağ geçidi verisi", 422, parsed.error.flatten());
  }
  const { type, name, zoneSlug, location, notes } = parsed.data;

  const gatewayId = normalizeMac(parsed.data.gatewayId);
  if (!gatewayId) {
    return fail(
      msg(
        ctx.user,
        "Geçersiz gateway kimliği (MAC, 12 hane hex bekleniyor)",
        "Geçersiz ağ geçidi kodu: 12 karakter olmalı (rakamlar ve A-F harfleri)",
      ),
      422,
    );
  }

  const taken = msg(
    ctx.user,
    "Bu MAC adresi başka bir hesapta kayıtlı. Yöneticinize başvurun.",
    "Bu kod başka bir hesapta kayıtlı. Yöneticinize başvurun.",
  );

  const idx = await getTenancy();
  const gwOwner = idx.gatewayOwner.get(gatewayId);
  if (gwOwner) {
    if (gwOwner === ctx.customer.id) {
      return fail(msg(ctx.user, "Bu gateway zaten kayıtlı", "Bu ağ geçidi zaten kayıtlı"), 409);
    }
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "gateway.create_conflict",
      target: gatewayId,
    });
    return fail(taken, 409);
  }

  // Cihaz olarak kayıtlı mı? (bölgesiz cihaz tenancy'de yok → DB'ye bakılır)
  const [dev] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, gatewayId))
    .limit(1);
  if (dev) {
    return fail(
      idx.deviceOwner.get(gatewayId) === ctx.customer.id
        ? msg(ctx.user, "Bu MAC bir cihaz olarak kayıtlı", "Bu kod bir cihaz olarak kayıtlı")
        : taken,
      409,
    );
  }

  let zoneId: string | null = null;
  if (zoneSlug) {
    const z = await resolveGatewayZone(ctx.customer.id, zoneSlug);
    if (z === undefined) return fail("Bölge bulunamadı", 404);
    zoneId = z;
  }

  try {
    await db.insert(schema.gateways).values({
      gatewayId,
      customerId: ctx.customer.id,
      zoneId,
      type,
      name: name || null,
      location: location || null,
      notes: notes || null,
    });
    await refreshTenancy();
    forgetDiscoveredGateway(gatewayId);
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "gateway.create",
      target: gatewayId,
      detail: { type, name: name ?? null, zoneSlug: zoneSlug ?? null },
    });

    const [view] = await listGateways(ctx.customer.id, { technical, gatewayId });
    return ok(view, { status: 201 });
  } catch (err) {
    return fail("Ağ geçidi oluşturulamadı", 500, String(err));
  }
}
