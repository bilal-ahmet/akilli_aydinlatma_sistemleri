import { ok, fail } from "@/lib/api/respond";
import { authorizeDevice } from "@/lib/auth/guard";
import { normalizeMac } from "@/lib/mac";
import { loadDeviceMesh } from "@/lib/mesh/query";

export const runtime = "nodejs";

/**
 * GET /api/devices/:mac/mesh — cihaz modalının "Ağ" sekmesi (YALNIZCA ADMIN):
 * BR'ye giden yol, komşular (adları çözülmüş), 24 sa saatlik parent RSSI ve
 * yol maliyeti. Müşteri kullanıcılarına 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  const mac = normalizeMac(deviceId);
  if (!mac) return fail("Geçersiz MAC", 400);
  const ctx = await authorizeDevice(req, mac, "read");
  if (ctx instanceof Response) return ctx;
  if (ctx.user.role !== "admin") return fail("Bulunamadı", 404);
  if (!ctx.customerId) return fail("Cihaz bulunamadı", 404);
  try {
    return ok(await loadDeviceMesh(ctx.customerId, mac));
  } catch (err) {
    return fail("Ağ bilgisi okunamadı", 500, String(err));
  }
}
