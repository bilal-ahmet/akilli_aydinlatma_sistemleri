import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getTenancy } from "@/lib/tenancy";
import type { Role } from "./roles";
import type { TokenPair } from "@/types/auth";
import { ACCESS_TTL_S, signAccessToken } from "./token";
import { revokeSid } from "./revocation";
import { sessionUserFromIndex, type SessionUser } from "./session";

/**
 * Mobil oturumlar: kısa ömürlü access token (JWT, 15 dk) + dönen refresh
 * token (opak, 30 gün, her kullanımda yenilenir). Bir `auth_sessions` satırı
 * bir cihazdır; çıkış yalnızca o cihazı düşürür.
 *
 * İptal katmanları:
 *  - Şifre değişimi/sıfırlama: `users.token_version` artar → hem access (index
 *    kontrolü) hem refresh (satırdaki sürüm tutmaz) anında geçersiz.
 *  - Pasifleştirme/silme: index kontrolü access'i, refresh'teki aktiflik
 *    kontrolü refresh'i düşürür; silmede satır FK ile silinir.
 *  - Çıkış / çalınma: satır `revoked_at` ile iptal + `revokeSid` ile elde
 *    kalan access token da anında düşer.
 */

export const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 gün (kayan)

/**
 * Eski refresh token'ın rotasyondan sonra hâlâ kabul edildiği pencere. Mobil
 * ağda yanıt kaybolabilir (sunucu döndürdü, istemci yeni token'ı alamadı);
 * bu pencerede eski token ile gelen istek yeniden kullanım SAYILMAZ, oturum
 * tekrar döndürülür. Pencere dışında eski token = çalınmış kabul edilir.
 */
const ROTATION_GRACE_MS = 2 * 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

type Issued = { pair: TokenPair; sessionId: string };

async function issueAccess(
  user: { id: string; role: Role; customerId: string | null; tokenVersion: number },
  sessionId: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): Promise<TokenPair> {
  const accessToken = await signAccessToken({
    sub: user.id,
    role: user.role,
    cid: user.customerId,
    tv: user.tokenVersion,
    sid: sessionId,
  });
  return {
    accessToken,
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
    refreshToken,
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

/** Girişte yeni cihaz oturumu açar. */
export async function createMobileSession(
  user: { id: string; role: Role; customerId: string | null; tokenVersion: number },
  device: { deviceName?: string; platform?: string },
): Promise<Issued> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_S * 1000);
  const [row] = await db
    .insert(schema.authSessions)
    .values({
      userId: user.id,
      refreshHash: hashToken(refreshToken),
      tokenVersion: user.tokenVersion,
      deviceName: device.deviceName ?? null,
      platform: device.platform ?? null,
      expiresAt,
    })
    .returning({ id: schema.authSessions.id });
  return { pair: await issueAccess(user, row.id, refreshToken, expiresAt), sessionId: row.id };
}

/**
 * Oturumun refresh token'ını döndürür (satırı günceller).
 *
 * `keepPrevious`: eski token tolerans penceresinde kabul edilsin mi. Yalnızca
 * normal refresh rotasyonunda true (yanıtı kaybolan istemci). Şifre
 * değişiminde FALSE: eski token hemen ve tamamen geçersiz olmalı, yoksa onu
 * ele geçiren biri pencere içinde yeni bir oturum alabilirdi.
 */
async function rotate(
  sessionId: string,
  currentHash: string,
  user: SessionUser,
  tokenVersion: number,
  keepPrevious: boolean,
): Promise<TokenPair> {
  const refreshToken = newRefreshToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_S * 1000);
  await db
    .update(schema.authSessions)
    .set({
      refreshHash: hashToken(refreshToken),
      prevRefreshHash: keepPrevious ? currentHash : null,
      tokenVersion,
      lastUsedAt: now,
      expiresAt,
    })
    .where(eq(schema.authSessions.id, sessionId));
  return issueAccess(
    { id: user.id, role: user.role, customerId: user.customerId, tokenVersion },
    sessionId,
    refreshToken,
    expiresAt,
  );
}

export async function revokeSession(sessionId: string): Promise<void> {
  revokeSid(sessionId);
  await db
    .update(schema.authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.authSessions.id, sessionId), isNull(schema.authSessions.revokedAt)));
}

/** Refresh token'ı sahibi olan oturumu iptal eder (çıkışta access yoksa). */
export async function revokeByRefreshToken(refreshToken: string): Promise<void> {
  const hash = hashToken(refreshToken);
  const [row] = await db
    .select({ id: schema.authSessions.id })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.refreshHash, hash))
    .limit(1);
  if (row) await revokeSession(row.id);
}

export type RefreshResult =
  | { ok: true; pair: TokenPair; user: SessionUser }
  | { ok: false; message: string };

const INVALID = "Oturum geçersiz. Lütfen tekrar giriş yapın.";

/**
 * `POST /api/auth/refresh`: refresh token'ı doğrular ve döndürür.
 * Kullanıcı/müşteri geçerliliği `sessionUserFromIndex` ile — access token
 * doğrulamasıyla AYNI kural (aktiflik, token sürümü, müşteri aktifliği).
 */
export async function refreshMobileSession(req: Request, refreshToken: string): Promise<RefreshResult> {
  const hash = hashToken(refreshToken);
  const now = Date.now();

  let [row] = await db
    .select()
    .from(schema.authSessions)
    .where(eq(schema.authSessions.refreshHash, hash))
    .limit(1);

  if (!row) {
    // Döndürülmüş (eski) token mı?
    const [old] = await db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.prevRefreshHash, hash))
      .limit(1);
    if (!old) return { ok: false, message: INVALID };
    if (!old.revokedAt && now - old.lastUsedAt.getTime() <= ROTATION_GRACE_MS) {
      // Yanıtı kaybolmuş rotasyon: tolerans penceresinde yeniden döndür.
      row = old;
    } else {
      if (!old.revokedAt) {
        await revokeSession(old.id);
        const owner = (await getTenancy()).users.get(old.userId);
        await audit({
          req,
          user: { id: old.userId, username: owner?.username ?? "" },
          customerId: owner?.customerId ?? null,
          action: "auth.refresh_reuse",
          target: old.id,
          detail: { deviceName: old.deviceName, platform: old.platform },
        });
      }
      return { ok: false, message: INVALID };
    }
  }

  if (row.revokedAt || row.expiresAt.getTime() <= now) {
    return { ok: false, message: INVALID };
  }

  const user = await sessionUserFromIndex(row.userId, row.tokenVersion, "bearer", row.id);
  if (!user) {
    // Şifre değişti, kullanıcı/müşteri pasif ya da silindi.
    await revokeSession(row.id);
    return { ok: false, message: INVALID };
  }

  // Hangi token geldiyse (güncel ya da tolerans içindeki eski) satırdaki
  // GÜNCEL özet "önceki" olur; böylece eski token pencere sonunda da düşer.
  const pair = await rotate(row.id, row.refreshHash, user, row.tokenVersion, true);
  return { ok: true, pair, user };
}

/**
 * Şifre değişiminden sonra İSTEĞİ YAPAN mobil oturumu yeni token sürümüne
 * taşır ve yeni çift verir. Aynı kullanıcının diğer oturumları sürüm
 * uyuşmazlığıyla düşer (web çerezinde de aynı semantik).
 */
export async function reissueAfterPasswordChange(
  user: SessionUser,
  sessionId: string,
  tokenVersion: number,
): Promise<TokenPair | null> {
  const [row] = await db
    .select({ refreshHash: schema.authSessions.refreshHash, revokedAt: schema.authSessions.revokedAt })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.id, sessionId))
    .limit(1);
  if (!row || row.revokedAt) return null;
  return rotate(sessionId, row.refreshHash, user, tokenVersion, false);
}
