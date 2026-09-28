import { redirect } from "next/navigation";
import { homePathFor, requireUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/**
 * Kök: kullanıcıyı kendi açılış sayfasına yönlendirir.
 *  - admin    → /admin (müşteri listesi)
 *  - müşteri  → /c/<müşteri-slug> (kendi dashboard'u)
 *  - şifre değiştirmesi gereken → /hesap
 */
export default async function Home() {
  const user = await requireUser({ allowMustChange: true });
  redirect(homePathFor(user));
}
