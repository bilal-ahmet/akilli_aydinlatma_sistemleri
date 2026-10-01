import { ok, fail } from "@/lib/api/respond";
import { tokenRequestSchema } from "@/types/auth";
import { authenticate } from "@/lib/auth/credentials";
import { createMobileSession } from "@/lib/auth/mobileSession";
import { sessionUserFromIndex, toMe } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/roles";

export const runtime = "nodejs";

/**
 * POST /api/auth/token — MOBİL giriş. Web girişiyle aynı doğrulama
 * (lib/auth/credentials.ts); çerez yerine Bearer token çifti döner:
 *
 *   { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user: Me }
 *
 * `user.mustChangePassword` true ise uygulama önce şifre ekranına gitmeli
 * (diğer API'ler 403 döner, `/api/auth/me` ve `/api/auth/password` açık).
 */
export async function POST(req: Request) {
  const parsed = tokenRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Kullanıcı adı ve şifre gerekli", 422);
  const { deviceName, platform, ...credentials } = parsed.data;

  const result = await authenticate(req, credentials, { kind: "mobile", platform });
  if ("response" in result) return result.response;
  const { user } = result;

  const { pair, sessionId } = await createMobileSession(
    {
      id: user.id,
      role: user.role as Role,
      customerId: user.customerId,
      tokenVersion: user.tokenVersion,
    },
    { deviceName, platform },
  );

  const session = await sessionUserFromIndex(user.id, user.tokenVersion, "bearer", sessionId);
  if (!session) return fail("Oturum açılamadı, tekrar deneyin", 409);

  return ok({ ...pair, user: toMe(session) });
}
