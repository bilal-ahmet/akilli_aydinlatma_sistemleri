import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import { loadMesh } from "@/lib/mesh/query";

export const runtime = "nodejs";

/**
 * GET /api/mesh?customer=<slug> — Ağ haritası (YALNIZCA ADMIN).
 * Rota ağacı (health 0xCE/0xCF), yük/trafik tahmini, öneriler, son 24 sa ağ
 * olayları ve KPI serileri. Müşteri kullanıcılarına 404 (sayfa da yok).
 */
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  if (ctx.user.role !== "admin") return fail("Bulunamadı", 404);
  try {
    return ok(await loadMesh(ctx.customer.id));
  } catch (err) {
    return fail("Ağ haritası okunamadı", 500, String(err));
  }
}
