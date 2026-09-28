import "server-only";
import { db, schema } from "@/lib/db";
import { clientIp } from "@/lib/auth/rateLimit";

/**
 * Denetim kaydı yazar. ASLA fırlatmaz: denetim kaydı yazılamadı diye asıl
 * işlem başarısız sayılmamalı (yalnızca loglanır).
 *
 * `customerId` = işlemin yapıldığı müşteri (admin başka müşterinin panelinde
 * çalıştığında o müşteri). `user` null ise (örn. başarısız giriş) yalnızca
 * denenen kullanıcı adı yazılır.
 */
export async function audit(entry: {
  req?: Request;
  user?: { id: string; username: string } | null;
  username?: string;
  customerId?: string | null;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      userId: entry.user?.id ?? null,
      username: (entry.user?.username ?? entry.username ?? null)?.slice(0, 64) ?? null,
      customerId: entry.customerId ?? null,
      action: entry.action,
      target: entry.target?.slice(0, 150) ?? null,
      detail: entry.detail ?? null,
      ip: entry.req ? clientIp(entry.req).slice(0, 64) : null,
    });
  } catch (err) {
    console.error("[audit] yazılamadı:", entry.action, err);
  }
}
