import { ok, fail, msg } from "@/lib/api/respond";
import { authorizeDevice } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { forceVerify, zoneSyncView } from "@/lib/zoneSync/engine";

export const runtime = "nodejs";

type Params = { params: Promise<{ deviceId: string }> };

/**
 * GET /api/devices/:deviceId/zone-sync — cihazın bölge aboneliği durumu.
 * Admin istenen ve cihazın bildirdiği topic listesini de görür.
 */
export async function GET(req: Request, { params }: Params) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "read");
  if (ctx instanceof Response) return ctx;
  return ok(zoneSyncView(deviceId, ctx.user.role === "admin"));
}

/**
 * POST /api/devices/:deviceId/zone-sync — "Şimdi doğrula": cihaza zone_list
 * gönderilir, fark varsa düzeltilir. Sonuç SSE `kind:"zone_sync"` ile gelir.
 */
export async function POST(req: Request, { params }: Params) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "write");
  if (ctx instanceof Response) return ctx;

  const r = forceVerify(deviceId);
  if (!r.sent) {
    const text =
      r.reason === "off"
        ? msg(ctx.user, "Bölge senkronu kapalı (MQTT_ZONE_SYNC=off)", "Bu işlem şu an kullanılamıyor")
        : r.reason === "busy"
          ? msg(ctx.user, "Cihaza zaten bir zone komutu gidiyor", "Cihaza zaten bölge bilgisi gönderiliyor")
          : msg(
              ctx.user,
              "Cihaz binary protokol konuşmuyor (eski firmware ya da henüz paket gelmedi)",
              "Cihaz bu özelliği desteklemiyor ya da henüz bağlanmadı",
            );
    return fail(text, 409);
  }
  await audit({ req, user: ctx.user, customerId: ctx.customerId, action: "device.zone_verify", target: deviceId });
  return ok(zoneSyncView(deviceId, ctx.user.role === "admin"), { status: 202 });
}
