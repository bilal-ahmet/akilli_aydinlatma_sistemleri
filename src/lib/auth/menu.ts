import "server-only";
import type { MenuLink } from "@/app/_components/UserMenu";
import type { Viewer } from "@/types/admin";
import type { SessionUser } from "./session";

/** Oturum kullanıcısından istemciye güvenle geçirilebilen alanlar. */
export function toViewer(user: SessionUser): Viewer {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

/** Kullanıcı menüsündeki bağlantılar — role ve bulunulan panele göre. */
export function menuLinksFor(user: SessionUser, customerSlug?: string): MenuLink[] {
  const links: MenuLink[] = [];
  if (user.role === "admin") links.push({ href: "/admin", label: "Müşteriler" });
  if (customerSlug) {
    links.push({ href: `/c/${customerSlug}`, label: "Dashboard" });
    if (user.role === "admin" || user.role === "manager") {
      links.push({ href: `/c/${customerSlug}/kullanicilar`, label: "Kullanıcılar" });
    }
  } else if (user.customer) {
    links.push({ href: `/c/${user.customer.slug}`, label: "Dashboard" });
  }
  links.push({ href: "/hesap", label: "Hesabım ve şifre" });
  return links;
}
