import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_RENEW_BELOW_S,
  sessionCookieOptions,
  signSession,
  verifySessionToken,
} from "@/lib/auth/token";

/**
 * Proxy (Next.js 16'da eski `middleware`) — YALNIZCA iyimser kontrol:
 * çerezdeki token'ın imzasını doğrular, DB'ye/tenancy index'ine bakmaz.
 *
 *  - Token yok/geçersiz → sayfada /login'e yönlendir, /api'de 401.
 *  - Token'ın ömrü azaldıysa yenilenmiş çerezle devam et (kayan oturum).
 *
 * Asıl yetki (rol, müşteri, iptal) her sayfada `lib/auth/dal.ts`, her API
 * route'unda `lib/auth/guard.ts` ile yapılır — proxy tek başına güvenlik
 * sınırı DEĞİLDİR.
 */

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  let claims = null;
  try {
    claims = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    claims = null; // SESSION_SECRET eksikse de herkes girişe düşer
  }

  if (!claims) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ ok: false, error: "Oturum gerekli" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  const left = (claims.exp ?? 0) - Math.floor(Date.now() / 1000);
  // SSE isteğinde çerez yazmak gereksiz (uzun ömürlü akış); sayfa ve normal API'de yenile.
  if (left < SESSION_RENEW_BELOW_S && pathname !== "/api/events") {
    const token = await signSession({ sub: claims.sub, role: claims.role, cid: claims.cid, tv: claims.tv });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  }
  return res;
}

export const config = {
  matcher: [
    // Statik dosyalar ve Next iç yolları hariç her şey.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
