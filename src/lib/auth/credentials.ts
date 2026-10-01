import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { UserRow } from "@/lib/db/schema";
import { fail } from "@/lib/api/respond";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { normalizeUsername } from "./roles";
import { burnPasswordCheck, verifyPassword } from "./password";
import { clearFailures, clientIp, lockedFor, recordFailure } from "./rateLimit";

const GENERIC = "Kullanıcı adı veya şifre hatalı";

/**
 * Kullanıcı adı + şifre doğrulaması — web girişi (`/api/auth/login`, çerez)
 * ve mobil girişi (`/api/auth/token`, Bearer) AYNI kuralları buradan alır:
 * rate limit (IP+kullanıcı), kullanıcı yokken de sahte doğrulama (zamanlama
 * ile kullanıcı adı tahmini engellenir), kullanıcı/müşteri aktifliği,
 * `last_login_at`, tenancy index'i ve denetim kaydı.
 *
 * Başarıda kullanıcı satırı, başarısızlıkta döndürülecek hazır `Response`.
 * Hata mesajı hangi alanın yanlış olduğunu söylemez.
 */
export async function authenticate(
  req: Request,
  credentials: { username: string; password: string },
  client: { kind: "web" | "mobile"; platform?: string },
): Promise<{ user: UserRow } | { response: Response }> {
  const username = normalizeUsername(credentials.username);
  const key = `${clientIp(req)}|${username}`;
  const wait = lockedFor(key);
  if (wait > 0) {
    return {
      response: fail(
        `Çok fazla hatalı deneme. ${Math.ceil(wait / 60)} dakika sonra tekrar deneyin.`,
        429,
      ),
    };
  }

  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);

  const valid = user
    ? await verifyPassword(credentials.password, user.passwordHash)
    : (await burnPasswordCheck(credentials.password), false);

  const detail = client.kind === "mobile" ? { client: "mobile", platform: client.platform ?? null } : null;

  if (!user || !valid) {
    recordFailure(key);
    await audit({ req, username, action: "auth.login_failed", customerId: user?.customerId, detail });
    return { response: fail(GENERIC, 401) };
  }

  if (!user.isActive) {
    await audit({ req, user, action: "auth.login_inactive", customerId: user.customerId, detail });
    return { response: fail("Hesabınız pasif. Yöneticinize başvurun.", 403) };
  }
  if (user.customerId) {
    const customer = (await getTenancy()).customersById.get(user.customerId);
    if (!customer?.isActive) {
      await audit({ req, user, action: "auth.login_inactive", customerId: user.customerId, detail });
      return { response: fail("Müşteri hesabı pasif. Yöneticinize başvurun.", 403) };
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

  await audit({ req, user, action: "auth.login", customerId: user.customerId, detail });
  return { user };
}
