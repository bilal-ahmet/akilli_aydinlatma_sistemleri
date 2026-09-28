import { SignJWT, jwtVerify } from "jose";
import type { Role } from "./roles";

/**
 * Oturum token'ı: HS256 imzalı JWT, HttpOnly çerezde taşınır. Yalnızca kimlik
 * ve iptal için gereken minimum veri: kullanıcı id, rol, müşteri id, token
 * sürümü. Rol/aktiflik her istekte bellek içi tenancy index'inden TEKRAR
 * okunur (bkz. session.ts); token'daki rol yalnızca proxy'nin iyimser
 * yönlendirmesi içindir.
 *
 * Bu dosya `server-only` import etmez çünkü `src/proxy.ts` de kullanır.
 */
export const SESSION_COOKIE = "fener_session";
export const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 gün
/** Kalan ömür bunun altına düşünce proxy çerezi yeniler (kayan oturum). */
export const SESSION_RENEW_BELOW_S = 3 * 24 * 60 * 60;

export type SessionClaims = {
  sub: string; // user id
  role: Role;
  cid: string | null; // customer id (admin: null)
  tv: number; // token_version
  exp?: number;
};

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

export async function signSession(claims: Omit<SessionClaims, "exp">): Promise<string> {
  return new SignJWT({ role: claims.role, cid: claims.cid, tv: claims.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    return {
      sub: payload.sub,
      role: payload.role as Role,
      cid: (payload.cid as string | null) ?? null,
      tv: Number(payload.tv ?? 0),
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_S,
};
