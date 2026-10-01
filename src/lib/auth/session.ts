import "server-only";
import { cookies, headers } from "next/headers";
import { getTenancy, type CustomerInfo } from "@/lib/tenancy";
import { canWrite, type Role } from "./roles";
import { isSidRevoked } from "./revocation";
import {
  SESSION_COOKIE,
  bearerToken,
  sessionCookieOptions,
  signSession,
  verifyAccessToken,
  verifySessionToken,
} from "./token";
import type { Me } from "@/types/auth";

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
  /** Kimliğin kaynağı: web çerezi mi, mobil Bearer token mı. */
  via: "cookie" | "bearer";
  /** Bearer ise mobil cihaz oturumu (`auth_sessions.id`), çerezde null. */
  sessionId: string | null;
};

/**
 * Kullanıcıyı tenancy index'inden kurar ve geçerliliğini kontrol eder:
 * kullanıcı var + aktif + token sürümü tutuyor + (müşteri kullanıcısıysa)
 * müşterisi var ve aktif. Geçersizse null.
 */
export async function sessionUserFromIndex(
  userId: string,
  tokenVersion: number,
  via: SessionUser["via"],
  sessionId: string | null,
): Promise<SessionUser | null> {
  const idx = await getTenancy();
  const u = idx.users.get(userId);
  if (!u || !u.isActive || u.tokenVersion !== tokenVersion) return null;

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
    via,
    sessionId,
  };
}

/**
 * İsteğin oturumunu çözer — TEK yer. Sıra:
 *  1. `Authorization: Bearer <access>` (mobil). Başlık varsa ama geçersizse
 *     null döner, çereze DÜŞMEZ (açıkça gönderilen kimlik belirleyicidir).
 *  2. `fener_session` çerezi (web).
 * Her iki yolda da index kontrolleri aynıdır. DB'ye gitmez (index sıcaksa).
 */
export async function readSession(): Promise<SessionUser | null> {
  const bearer = bearerToken((await headers()).get("authorization"));
  if (bearer !== undefined) {
    const claims = await verifyAccessToken(bearer);
    if (!claims || isSidRevoked(claims.sid)) return null;
    return sessionUserFromIndex(claims.sub, claims.tv, "bearer", claims.sid);
  }

  const store = await cookies();
  const claims = await verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  return sessionUserFromIndex(claims.sub, claims.tv, "cookie", null);
}

/** İstemciye verilen kimlik özeti (`GET /api/auth/me`, mobil giriş yanıtı). */
export function toMe(user: SessionUser): Me {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    canWrite: canWrite(user.role),
    mustChangePassword: user.mustChangePassword,
    customer: user.customer
      ? {
          id: user.customer.id,
          slug: user.customer.slug,
          name: user.customer.name,
          isActive: user.customer.isActive,
        }
      : null,
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
