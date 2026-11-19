import { after } from "next/server";
import { publishGatewayCommand, recordGatewayCommand } from "@/lib/mqtt";
import { gatewayCommandSchema } from "@/types/lighting";
import { ok, fail, msg } from "@/lib/api/respond";
import { authorizeGateway } from "@/lib/auth/guard";
import { otaRepeatBlock } from "@/lib/otaGuard";
import { audit } from "@/lib/audit";
import { normalizeMac } from "@/lib/mac";

export const runtime = "nodejs";

/**
 * POST /api/gateways/:gatewayId/command  { action: "report_now" | "ota_check" }
 * → Meven:<GW_ID>/cmd'ye binary 0x03 komut (lib/mqtt.ts → publishGatewayCommand).
 * Yanıt gateway'in COMMAND_ACK'iyle SSE'den gelir (`kind:"gateway"`,
 * `gatewayCommand`). "Şimdi raporla" yönetici + admin; güncelleme kontrolü
 * gateway'i yeniden başlatabildiği için yalnızca admin.
 * Publish önce, DB sonra (Kural #10) — guard ve OTA koruması bellek içi.
 */
export async function POST(req: Request, { params }: { params: Promise<{ gatewayId: string }> }) {
  const raw = (await params).gatewayId;
  const gatewayId = normalizeMac(raw) ?? raw;
  const ctx = await authorizeGateway(req, gatewayId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = gatewayCommandSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Geçersiz ağ geçidi komutu", 422, parsed.error.flatten());
  const { action } = parsed.data;

  if (action === "ota_check") {
    if (ctx.user.role !== "admin") return fail("Bu işlem yalnızca yöneticiye açık", 403);
    const block = otaRepeatBlock(gatewayId);
    if (block?.reason === "busy") {
      return fail("Ağ geçidi zaten güncelleme yapıyor; bitmesini bekleyin.", 409);
    }
    if (block?.reason === "recent") {
      return fail(
        `Bu ağ geçidine az önce güncelleme kontrolü gönderildi. ~${block.retryAfterSec} sn sonra tekrar deneyin.`,
        409,
        { retryAfterSec: block.retryAfterSec },
      );
    }
  }

  let requestId: string;
  try {
    ({ requestId } = publishGatewayCommand(gatewayId, action));
  } catch (err) {
    return fail(
      msg(ctx.user, "Komut yayınlanamadı (MQTT)", "Komut gönderilemedi, lütfen tekrar deneyin"),
      502,
      String(err),
    );
  }

  after(async () => {
    await recordGatewayCommand(gatewayId, requestId, action, {
      userId: ctx.user.id,
      customerId: ctx.customer.id,
    }).catch((err) => console.error("[gateway] komut kaydı başarısız:", err));
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: `gateway.${action}`,
      target: gatewayId,
      detail: { requestId },
    });
  });

  return ok({ requestId, status: "pending" }, { status: 202 });
}
