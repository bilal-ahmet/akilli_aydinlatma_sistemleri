/**
 * Rol tanımları — hem sunucu hem istemci kullanır (server-only DEĞİL).
 *
 *  - admin   : platform yöneticisi. Tüm müşterileri görür ve yönetir, customerId yok.
 *  - manager : müşteri yöneticisi. Kendi müşterisinde tam yetki (bölge/cihaz/kullanıcı).
 *  - viewer  : müşteri izleyicisi. Kendi müşterisinde salt okunur.
 */
export const ROLES = ["admin", "manager", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const CUSTOMER_ROLES = ["manager", "viewer"] as const;
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Sistem yöneticisi",
  manager: "Yönetici",
  viewer: "İzleyici",
};

/** Bu rol verilen müşteride yazma (komut, CRUD) yapabilir mi? */
export function canWrite(role: Role): boolean {
  return role === "admin" || role === "manager";
}

/** Parola politikası — sunucu ve form aynı kuralı kullanır. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Kullanıcı adı: küçük harf, rakam, nokta, alt çizgi, tire; 3-64 karakter. */
export const USERNAME_RE = /^[a-z0-9._-]{3,64}$/;

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}
