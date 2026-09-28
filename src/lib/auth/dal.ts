import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getTenancy, type CustomerInfo } from "@/lib/tenancy";
import { readSession, type SessionUser } from "./session";

/**
 * Sayfalar (Server Component) için Data Access Layer. Next.js 16 önerisi:
 * yetki kontrolü proxy'de DEĞİL, veriye yakın yapılır; proxy yalnızca
 * iyimser yönlendirme yapar. `cache` ile bir render boyunca tek doğrulama.
 */
export const getSession = cache(readSession);

/** Girişli kullanıcı; yoksa /login. Şifre değiştirmesi gerekiyorsa /hesap. */
export async function requireUser(opts?: { allowMustChange?: boolean }): Promise<SessionUser> {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !opts?.allowMustChange) redirect("/hesap");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}

/**
 * Müşteri paneline erişim: admin her müşteriye, müşteri kullanıcısı yalnızca
 * kendisine. Başka müşterinin paneli için 404 (varlığı sızdırılmaz).
 */
export async function requireCustomerAccess(
  slug: string,
): Promise<{ user: SessionUser; customer: CustomerInfo }> {
  const user = await requireUser();
  const customer = (await getTenancy()).customersBySlug.get(slug);
  if (!customer) notFound();
  if (user.role !== "admin" && user.customerId !== customer.id) notFound();
  return { user, customer };
}

/** Girişten sonra kullanıcının açılış sayfası. */
export function homePathFor(user: SessionUser): string {
  if (user.mustChangePassword) return "/hesap";
  if (user.role === "admin") return "/admin";
  return `/c/${user.customer?.slug ?? ""}`;
}
