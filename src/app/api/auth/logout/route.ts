import { ok } from "@/lib/api/respond";
import { clearSessionCookie, readSession } from "@/lib/auth/session";
import { revokeByRefreshToken, revokeSession } from "@/lib/auth/mobileSession";
import { logoutRequestSchema } from "@/types/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout — oturumu kapatır. Guard'sızdır (Kural #11 istisnası):
 * oturumu zaten düşmüş istemci de çıkabilmelidir.
 *
 *  - Web: çerezi siler.
 *  - Mobil: Bearer ile gelirse o cihaz oturumunu iptal eder; gövdede
 *    `refreshToken` varsa (access süresi dolmuş olabilir) onun oturumunu da.
 *    Elde kalan access token `revokeSid` ile anında düşer.
 */
export async function POST(req: Request) {
  const body = logoutRequestSchema.safeParse(await req.json().catch(() => ({})));
  const user = await readSession();

  if (user?.via === "bearer" && user.sessionId) {
    await revokeSession(user.sessionId);
    await audit({ req, user, action: "auth.logout", customerId: user.customerId, detail: { client: "mobile" } });
  }
  if (body.success && body.data.refreshToken) {
    await revokeByRefreshToken(body.data.refreshToken);
  }

  await clearSessionCookie();
  return ok({ redirect: "/login" });
}
