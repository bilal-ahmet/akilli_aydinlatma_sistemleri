import { ok } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { listDiscoveredGateways } from "@/lib/gatewayDiscovery";

export const runtime = "nodejs";

/**
 * GET /api/admin/gateways/discovered — MQTT'ye gateway türüyle yayın yapan ama
 * hiçbir müşteriye kayıtlı olmayan GW_ID'ler (bellek içi, son 24 saat).
 * Admin buradan bir müşteriye kaydeder.
 */
export async function GET(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  const idx = await getTenancy();
  return ok(
    listDiscoveredGateways((id) => idx.gatewayOwner.has(id) || idx.deviceOwner.has(id)),
  );
}
