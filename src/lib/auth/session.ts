import "server-only";
import { cookies } from "next/headers";
import { getTenancy, type CustomerInfo } from "@/lib/tenancy";
import type { Role } from "./roles";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  signSession,
  verifySessionToken,
} from "./token";

/**
 * Doğrulanmış oturum kullanıcısı. Rol, müşteri ve aktiflik token'dan DEĞİL,
 * tenancy index'inden okunur — böylece admin bir kullanıcının rolünü
 * değiştirdiğinde ya da onu pasifleştirdiğinde etki hemen başlar.
 */
export type SessionUser = {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  customerId: string | null;
  customer: CustomerInfo | null;
  mustChangePassword: boolean;
};

/**
 * Çerezdeki token'ı doğrular ve kullanıcıyı index'e karşı kontrol eder.
 * DB'ye gitmez (index sıcaksa). Geçersiz/iptal edilmiş oturumda null.
 */
export async function readSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;

  const idx = await getTenancy();
  const u = idx.users.get(claims.sub);
  if (!u || !u.isActive || u.tokenVersion !== claims.tv) return null;

  let customer: CustomerInfo | null = null;
  if (u.role !== "admin") {
    customer = u.customerId ? (idx.customersById.get(u.customerId) ?? null) : null;
    if (!customer || !customer.isActive) return null;
  }

  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    customerId: u.customerId,
    customer,
    mustChangePassword: u.mustChangePassword,
  };
}

/** Oturum çerezini yazar (girişte ve şifre değişiminde). */
export async function writeSessionCookie(user: {
  id: string;
  role: Role;
  customerId: string | null;
  tokenVersion: number;
}): Promise<void> {
  const token = await signSession({
    sub: user.id,
    role: user.role,
    cid: user.customerId,
    tv: user.tokenVersion,
  });
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
