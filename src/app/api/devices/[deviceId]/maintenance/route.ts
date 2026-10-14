import { after } from "next/server";
import { publishMaintenance, recordMaintenance } from "@/lib/mqtt";
import { maintenanceRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";
import { authorizeDevice } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { otaBlockReason } from "@/lib/otaGuard";
import { audit } from "@/lib/audit";
import { formatMac } from "@/lib/mac";

export const runtime = "nodejs";

// POST /api/devices/:deviceId/maintenance  { action: "commission" | "ota_check" }
// → Meven:<MAC>/cmd'ye {"action","id"}. YALNIZCA tek cihaz: bakım komutlarının
// bölge / toplu karşılığı bilerek yok (OTA toplu gönderilirse Thread ağı tıkanır).
// Lamba taraması manager'a da açık; OTA cihazı yeniden başlattığı için yalnızca admin.
// Publish önce, DB sonra (Kural #10) — guard ve OTA koruması bellek içi.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = maintenanceRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz bakım komutu", 422, parsed.error.flatten());
  }
  const { action } = parsed.data;

  if (action === "ota_check") {
    if (ctx.user.role !== "admin") return fail("Bu işlem yalnızca yöneticiye açık", 403);

    const idx = await getTenancy();
    const zone = idx.deviceZone.get(deviceId);
    const peers = zone
      ? [...idx.deviceZone].filter(([mac, z]) => z === zone && mac !== deviceId).map(([mac]) => mac)
      : [];
    const block = otaBlockReason(deviceId, peers);
    if (block?.reason === "busy") {
      return fail("Cihaz zaten güncelleme yapıyor; bitmesini bekleyin.", 409);
    }
    if (block?.reason === "zone-busy") {
      return fail(
        `Aynı bölgede ${formatMac(block.peer)} güncelleniyor. Thread ağı tıkanmasın diye ` +
          `~${block.retryAfterSec} sn sonra tekrar deneyin.`,
        409,
        { peer: block.peer, retryAfterSec: block.retryAfterSec },
      );
    }
  }

  let requestId: string;
  try {
    ({ requestId } = publishMaintenance(deviceId, action));
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }

  after(async () => {
    await recordMaintenance(deviceId, requestId, action, {
      userId: ctx.user.id,
      customerId: ctx.customerId,
    }).catch((err) => console.error("[maintenance] kayıt başarısız:", err));
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customerId,
      action: `device.${action}`,
      target: deviceId,
      detail: { requestId },
    });
  });

  return ok({ requestId, status: "pending" }, { status: 202 });
}
