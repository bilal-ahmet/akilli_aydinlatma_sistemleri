import "server-only";
import { ACCESS_TTL_S } from "./token";

/**
 * İptal edilmiş mobil oturumlar (`auth_sessions.id`) — bellek içi.
 *
 * Access token stateless'tır (15 dk). Çıkışta ya da refresh yeniden
 * kullanımı tespit edildiğinde oturumun refresh'i DB'de iptal edilir; bu küme
 * ise elde kalmış access token'ı da ANINDA düşürür. Bir kayıt, o anda
 * verilmiş olabilecek son access token'ın ömrü kadar tutulur, sonra silinir.
 *
 * Tek instance varsayımı (Kural #8). Süreç yeniden başlarsa küme boşalır;
 * en kötü durumda iptal edilmiş oturumun access token'ı kalan ömrü (≤15 dk)
 * boyunca geçerli kalır — refresh zaten DB'de iptal olduğu için uzatılamaz.
 * Şifre değişimi, pasifleştirme ve silme bu kümeye muhtaç değildir:
 * `token_version` ve aktiflik her istekte tenancy index'inden kontrol edilir.
 */
const g = globalThis as unknown as { __fenerRevokedSids?: Map<string, number> };
const revoked = (g.__fenerRevokedSids ??= new Map<string, number>());

export function revokeSid(sid: string): void {
  const now = Date.now();
  revoked.set(sid, now + ACCESS_TTL_S * 1000);
  if (revoked.size > 1000) {
    for (const [k, until] of revoked) if (until < now) revoked.delete(k);
  }
}

export function isSidRevoked(sid: string): boolean {
  const until = revoked.get(sid);
  if (until === undefined) return false;
  if (until < Date.now()) {
    revoked.delete(sid);
    return false;
  }
  return true;
}
