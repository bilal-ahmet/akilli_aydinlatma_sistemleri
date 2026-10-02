import "server-only";
import { fail } from "@/lib/api/respond";
import { getTenancy, type CustomerInfo } from "@/lib/tenancy";
import { canWrite } from "./roles";
import { readSession, type SessionUser } from "./session";

/**
 * API route'ları için yetki kapısı. KURAL: her `/api/*` handler'ı (auth/login
 * hariç) ilk iş olarak bu fonksiyonlardan birini çağırır ve dönen değer
 * `Response` ise onu döndürür:
 *
 *   const ctx = await authorizeScope(req, "read");
 *   if (ctx instanceof Response) return ctx;
 *
 * DB'ye gitmez (tenancy index + JWT) → komut yolunda kullanılabilir (Kural #10).
 *
 * Başka müşterinin kaynağına 404 döner: 403 kaynağın VAR olduğunu sızdırırdı.
 */

export type Need = "read" | "write";

export type ScopeCtx = { user: SessionUser; customer: CustomerInfo };
export type DeviceCtx = { user: SessionUser; customerId: string | null };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF ek savunması. Çerez SameSite=Lax olduğu için tarayıcı başka siteden
 * gelen POST'a çerezi zaten eklemez; bu kontrol ikinci katmandır. Origin
 * başlığı olmayan istekler (curl, script) serbesttir — ortam çerezi taşımazlar.
 */
function checkOrigin(req: Request): Response | null {
  if (!MUTATING.has(req.method)) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    if (host && new URL(origin).host === host) return null;
  } catch {
    /* bozuk origin → reddet */
  }
  return fail("Geçersiz istek kaynağı", 403);
}

/** Yalnızca girişli kullanıcı (rol/müşteri fark etmez). */
export async function authorizeUser(
  req: Request,
  opts?: { allowMustChange?: boolean },
): Promise<SessionUser | Response> {
  const bad = checkOrigin(req);
  if (bad) return bad;
  const user = await readSession();
  if (!user) return fail("Oturum gerekli", 401);
  if (user.mustChangePassword && !opts?.allowMustChange) {
    return fail("Devam etmeden önce şifrenizi değiştirmelisiniz", 403);
  }
  return user;
}

export async function authorizeAdmin(req: Request): Promise<SessionUser | Response> {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  if (user.role !== "admin") return fail("Bu işlem yalnızca yöneticiye açık", 403);
  return user;
}

function needCheck(user: SessionUser, need: Need): Response | null {
  if (need === "write" && !canWrite(user.role)) {
    return fail("İzleyici hesabı bu işlemi yapamaz", 403);
  }
  return null;
}

/**
 * Koleksiyon route'ları (liste/oluştur, özet, SSE, müşteri "Tüm Sistem"i):
 * kapsam `?customer=<slug>` ile verilir.
 *  - Müşteri kullanıcısı: kapsam her zaman kendi müşterisi; parametre başka
 *    müşteriyi gösterirse 403.
 *  - Admin: parametre zorunlu (hangi müşterinin panelinde olduğu).
 */
export async function authorizeScope(req: Request, need: Need): Promise<ScopeCtx | Response> {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  const denied = needCheck(user, need);
  if (denied) return denied;

  const slug = new URL(req.url).searchParams.get("customer");

  if (user.role !== "admin") {
    const own = user.customer!;
    if (slug && slug !== own.slug) return fail("Bu müşteriye erişim yetkiniz yok", 403);
    return { user, customer: own };
  }

  if (!slug) return fail("Müşteri belirtilmeli (?customer=<slug>)", 400);
  const customer = (await getTenancy()).customersBySlug.get(slug);
  if (!customer) return fail("Müşteri bulunamadı", 404);
  return { user, customer };
}

/** Tek bölge (slug) üzerindeki işlemler: bölgenin sahibi kullanıcının müşterisi olmalı. */
export async function authorizeZone(
  req: Request,
  zoneSlug: string,
  need: Need,
): Promise<ScopeCtx | Response> {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  const denied = needCheck(user, need);
  if (denied) return denied;

  const idx = await getTenancy();
  const ownerId = idx.zoneOwner.get(zoneSlug);
  const customer = ownerId ? idx.customersById.get(ownerId) : undefined;
  if (!customer) return fail("Bölge bulunamadı", 404);
  if (user.role !== "admin" && user.customerId !== customer.id) {
    return fail("Bölge bulunamadı", 404);
  }
  return { user, customer };
}

/**
 * Tek cihaz (MAC) üzerindeki işlemler. Kayıtsız (bölgesiz) MAC'lere yalnızca
 * admin erişebilir; müşteri için 404.
 */
export async function authorizeDevice(
  req: Request,
  mac: string,
  need: Need,
): Promise<DeviceCtx | Response> {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  const denied = needCheck(user, need);
  if (denied) return denied;

  const ownerId = (await getTenancy()).deviceOwner.get(mac) ?? null;
  if (user.role === "admin") return { user, customerId: ownerId };
  if (!ownerId || ownerId !== user.customerId) return fail("Cihaz bulunamadı", 404);
  return { user, customerId: ownerId };
}

/**
 * Bir müşterinin kullanıcılarını yönetme: admin veya o müşterinin manager'ı.
 */
export async function authorizeCustomerManage(
  req: Request,
  customerSlug: string,
  need: Need,
): Promise<ScopeCtx | Response> {
  const user = await authorizeUser(req);
  if (user instanceof Response) return user;
  const customer = (await getTenancy()).customersBySlug.get(customerSlug);
  if (!customer) return fail("Müşteri bulunamadı", 404);
  if (user.role === "admin") return { user, customer };
  if (user.customerId !== customer.id) return fail("Müşteri bulunamadı", 404);
  if (need === "write" && user.role !== "manager") {
    return fail("Bu işlem yöneticiye açık", 403);
  }
  return { user, customer };
}
