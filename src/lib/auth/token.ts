import { SignJWT, jwtVerify } from "jose";
import type { Role } from "./roles";

/**
 * Oturum token'ları: HS256 imzalı JWT. İki tür vardır ve `typ` claim'i ile
 * AYRILIR — biri diğerinin yerine kullanılamaz:
 *
 *  - `web`    : HttpOnly çerezde (`fener_session`) taşınır, 7 gün, kayan
 *               yenileme (proxy). `typ`'siz eski çerezler de `web` sayılır.
 *  - `access` : mobil uygulamanın `Authorization: Bearer` başlığı. 15 dk.
 *               `sid` = `auth_sessions` satırı (cihaz oturumu). Süresi dolunca
 *               mobil `/api/auth/refresh` ile yenisini alır.
 *
 * Yalnızca kimlik ve iptal için gereken minimum veri: kullanıcı id, rol,
 * müşteri id, token sürümü. Rol/aktiflik her istekte bellek içi tenancy
 * index'inden TEKRAR okunur (bkz. session.ts); token'daki rol yalnızca
 * proxy'nin iyimser yönlendirmesi içindir.
 *
 * Bu dosya `server-only` import etmez çünkü `src/proxy.ts` de kullanır.
 */
export const SESSION_COOKIE = "fener_session";
export const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 gün
/** Kalan ömür bunun altına düşünce proxy çerezi yeniler (kayan oturum). */
export const SESSION_RENEW_BELOW_S = 3 * 24 * 60 * 60;

/** Mobil access token ömrü. Kısa tutulur: iptal edilemeyen pencere budur. */
export const ACCESS_TTL_S = 15 * 60;

export type SessionClaims = {
  sub: string; // user id
  role: Role;
  cid: string | null; // customer id (admin: null)
  tv: number; // token_version
  exp?: number;
};

export type AccessClaims = SessionClaims & { sid: string };

type TokenType = "web" | "access";

let cachedKey: Uint8Array | null = null;

/**
 * SESSION_SECRET — MQTT env'inden AYRI doğrulanır (lib/env.ts). Böylece MQTT
 * yanlış yapılandırılsa da giriş çalışır (Kural #9).
 */
function secretKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET gerekli (en az 32 karakter)");
  }
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

function sign(
  claims: Omit<SessionClaims, "exp">,
  typ: TokenType,
  ttlS: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ role: claims.role, cid: claims.cid, tv: claims.tv, typ, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlS}s`)
    .sign(secretKey());
}

/** Web çerezi token'ı. */
export function signSession(claims: Omit<SessionClaims, "exp">): Promise<string> {
  return sign(claims, "web", SESSION_TTL_S);
}

/** Mobil access token'ı (`sid` = auth_sessions.id). */
export function signAccessToken(claims: Omit<AccessClaims, "exp">): Promise<string> {
  const { sid, ...rest } = claims;
  return sign(rest, "access", ACCESS_TTL_S, { sid });
}

async function verify(
  token: string | undefined,
): Promise<{ claims: SessionClaims; typ: TokenType | undefined; sid: unknown } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    return {
      claims: {
        sub: payload.sub,
        role: payload.role as Role,
        cid: (payload.cid as string | null) ?? null,
        tv: Number(payload.tv ?? 0),
        exp: payload.exp,
      },
      typ: payload.typ as TokenType | undefined,
      sid: payload.sid,
    };
  } catch {
    return null;
  }
}

/** Çerez token'ı: `typ` yok (eski çerez) ya da `web`. Access token REDDEDİLİR. */
export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  const v = await verify(token);
  if (!v) return null;
  if (v.typ !== undefined && v.typ !== "web") return null;
  return v.claims;
}

/** Bearer token'ı: yalnızca `typ:"access"` + `sid`. Çerez token'ı REDDEDİLİR. */
export async function verifyAccessToken(token: string | undefined): Promise<AccessClaims | null> {
  const v = await verify(token);
  if (!v || v.typ !== "access" || typeof v.sid !== "string") return null;
  return { ...v.claims, sid: v.sid };
}

/**
 * `Authorization` başlığından Bearer token'ı çıkarır. Başlık yoksa
 * `undefined`; başlık var ama Bearer değilse/boşsa `""` (geçersiz sayılır —
 * açıkça kimlik gönderen istek çereze DÜŞMEZ).
 */
export function bearerToken(header: string | null | undefined): string | undefined {
  if (header == null) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : "";
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_S,
};
