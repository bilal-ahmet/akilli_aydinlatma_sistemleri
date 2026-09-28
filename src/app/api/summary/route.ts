import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import { computeSummary } from "@/lib/summary";

export const runtime = "nodejs";

/**
 * GET /api/summary?customer=<slug> — dashboard üst şeridi için müşterinin
 * ÖLÇÜLMÜŞ sistem özeti (bkz. lib/summary.ts).
 */
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    return ok(await computeSummary(ctx.customer.macs));
  } catch (err) {
    return fail("Sistem özeti okunamadı", 500, String(err));
  }
}
