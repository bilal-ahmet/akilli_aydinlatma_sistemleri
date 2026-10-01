import { ok } from "@/lib/api/respond";
import { authorizeUser } from "@/lib/auth/guard";
import { toMe } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * GET /api/auth/me — oturumdaki kullanıcı: kimlik, rol, yazma yetkisi, şifre
 * değiştirme zorunluluğu ve (müşteri kullanıcısıysa) müşterisi. Şifre
 * değiştirmesi gereken kullanıcıya da açıktır: istemci yönlendirmeyi buna
 * göre yapar. Çerez (web) ve Bearer (mobil) ile çalışır.
 */
export async function GET(req: Request) {
  const user = await authorizeUser(req, { allowMustChange: true });
  if (user instanceof Response) return user;
  return ok(toMe(user));
}
