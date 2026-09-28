import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { loginSchema } from "@/types/auth";
import { normalizeUsername } from "@/lib/auth/roles";
import { burnPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { writeSessionCookie } from "@/lib/auth/session";
import { clearFailures, clientIp, lockedFor, recordFailure } from "@/lib/auth/rateLimit";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const GENERIC = "Kullanıcı adı veya şifre hatalı";

/**
 * POST /api/auth/login — kullanıcı adı + şifre ile oturum açar.
 * Hata mesajı hangi alanın yanlış olduğunu söylemez; kullanıcı yokken de
 * şifre doğrulaması kadar süre harcanır (kullanıcı adı tahmini engellenir).
 */
export async function POST(req: Request) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Kullanıcı adı ve şifre gerekli", 422);

  const username = normalizeUsername(parsed.data.username);
  const key = `${clientIp(req)}|${username}`;
  const wait = lockedFor(key);
  if (wait > 0) {
    return fail(`Çok fazla hatalı deneme. ${Math.ceil(wait / 60)} dakika sonra tekrar deneyin.`, 429);
  }

  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  const valid = user
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : (await burnPasswordCheck(parsed.data.password), false);

  if (!user || !valid) {
    recordFailure(key);
    await audit({ req, username, action: "auth.login_failed", customerId: user?.customerId });
    return fail(GENERIC, 401);
  }

  if (!user.isActive) {
    await audit({ req, user, action: "auth.login_inactive", customerId: user.customerId });
    return fail("Hesabınız pasif. Yöneticinize başvurun.", 403);
  }
  if (user.customerId) {
    const customer = (await getTenancy()).customersById.get(user.customerId);
    if (!customer?.isActive) {
      await audit({ req, user, action: "auth.login_inactive", customerId: user.customerId });
      return fail("Müşteri hesabı pasif. Yöneticinize başvurun.", 403);
    }
  }

  clearFailures(key);
  await db
    .update(schema.users)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.users.id, user.id));

  // Kullanıcı index'e henüz girmemiş olabilir (örn. script ile yeni açıldı).
  const idx = await getTenancy();
  if (!idx.users.has(user.id)) await refreshTenancy();

  await writeSessionCookie({
    id: user.id,
    role: user.role as "admin" | "manager" | "viewer",
    customerId: user.customerId,
    tokenVersion: user.tokenVersion,
  });
  await audit({ req, user, action: "auth.login", customerId: user.customerId });

  let redirect = "/";
  if (user.mustChangePassword) redirect = "/hesap";
  return ok({ redirect });
}
