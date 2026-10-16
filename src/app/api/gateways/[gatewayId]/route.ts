import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { gatewayUpdateSchema } from "@/types/lighting";
import { normalizeMac } from "@/lib/mac";
import { authorizeGateway } from "@/lib/auth/guard";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { forgetGatewayNodes } from "@/lib/mqtt";
import { listGateways, resolveGatewayZone } from "@/lib/gatewayStore";

export const runtime = "nodejs";

type Params = { params: Promise<{ gatewayId: string }> };

async function gwIdFrom(params: Params["params"]): Promise<string> {
  const { gatewayId } = await params;
  return normalizeMac(gatewayId) ?? gatewayId;
}

// GET /api/gateways/:gatewayId
export async function GET(req: Request, { params }: Params) {
  const gatewayId = await gwIdFrom(params);
  const ctx = await authorizeGateway(req, gatewayId, "read");
  if (ctx instanceof Response) return ctx;
  const [view] = await listGateways(ctx.customer.id, {
    technical: ctx.user.role === "admin",
    gatewayId,
  });
  return view ? ok(view) : fail("Ağ geçidi bulunamadı", 404);
}

/**
 * PATCH /api/gateways/:gatewayId — tür, isim, konum, not, bölge etiketi.
 * Kimlik (GW_ID) ve müşteri değişmez: başka müşteriye geçecek gateway silinip
 * orada yeniden kaydedilir.
 */
export async function PATCH(req: Request, { params }: Params) {
  const gatewayId = await gwIdFrom(params);
  const ctx = await authorizeGateway(req, gatewayId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = gatewayUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz güncelleme verisi", 422, parsed.error.flatten());
  }
  const d = parsed.data;

  const patch: Partial<typeof schema.gateways.$inferInsert> = {};
  if (d.type !== undefined) patch.type = d.type;
  if (d.name !== undefined) patch.name = d.name || null;
  if (d.location !== undefined) patch.location = d.location || null;
  if (d.notes !== undefined) patch.notes = d.notes || null;
  if (d.zoneSlug !== undefined) {
    const zoneId = await resolveGatewayZone(ctx.customer.id, d.zoneSlug);
    if (zoneId === undefined) return fail("Bölge bulunamadı", 404);
    patch.zoneId = zoneId;
  }

  try {
    await db.update(schema.gateways).set(patch).where(eq(schema.gateways.gatewayId, gatewayId));
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "gateway.update",
      target: gatewayId,
      detail: d,
    });
    const [view] = await listGateways(ctx.customer.id, {
      technical: ctx.user.role === "admin",
      gatewayId,
    });
    return view ? ok(view) : fail("Ağ geçidi bulunamadı", 404);
  } catch (err) {
    return fail("Ağ geçidi güncellenemedi", 500, String(err));
  }
}

/**
 * DELETE /api/gateways/:gatewayId — kaydı siler, cihazlardaki bağı kaldırır.
 * Gateway sahada yayın yapmaya devam ederse admin'in "keşfedilen" listesine
 * düşer.
 */
export async function DELETE(req: Request, { params }: Params) {
  const gatewayId = await gwIdFrom(params);
  const ctx = await authorizeGateway(req, gatewayId, "write");
  if (ctx instanceof Response) return ctx;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.devices)
        .set({ gatewayId: null })
        .where(eq(schema.devices.gatewayId, gatewayId));
      await tx.delete(schema.gateways).where(eq(schema.gateways.gatewayId, gatewayId));
    });
    await refreshTenancy();
    forgetGatewayNodes(gatewayId);
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "gateway.delete",
      target: gatewayId,
    });
    return ok({ deleted: gatewayId });
  } catch (err) {
    return fail("Ağ geçidi silinemedi", 500, String(err));
  }
}
