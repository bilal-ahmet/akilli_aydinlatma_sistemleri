import { ok } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { binProtoSnapshot } from "@/lib/binUplink";

export const runtime = "nodejs";

/**
 * GET /api/admin/binproto — binary protokol (Meven:<MAC>/bin) alımının özeti
 * (bellek içi, sunucu açılışından beri): kabul/ret sayaçları, binary gönderen
 * cihazlar, son retler ve son 24 saatte alan tablosu uyuşmazlığı alarmı.
 */
export async function GET(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  return ok(binProtoSnapshot(await getTenancy()));
}
