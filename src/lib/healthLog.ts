import "server-only";
import { db, schema } from "@/lib/db";
import { pruneOldRecords } from "@/lib/retention";

/**
 * Health geçmişi (`device_health_log`) — admin'in cihaz "Kayıtlar" sekmesi ve
 * indirme için. `devices.health` yalnızca son mesajı tuttuğundan her `/health`
 * ayrıca buraya eklenir. Müşteriye gösterilmez.
 *
 * Saklama: 90 gün (`lib/retention.ts`); temizlik health yazımının ardından,
 * saatte en fazla bir kez.
 */

/** Kayıtlı cihazın health mesajını geçmişe yazar. Hata yalnızca log'lanır. */
export async function appendHealthLog(
  mac: string,
  health: Record<string, unknown>,
  at: Date,
): Promise<void> {
  try {
    await db.insert(schema.deviceHealthLog).values({ deviceId: mac, health, recordedAt: at });
  } catch (err) {
    console.warn("[healthLog] yazılamadı:", mac, (err as Error).message);
    return;
  }
  pruneOldRecords("device_health_log", at.getTime());
}
