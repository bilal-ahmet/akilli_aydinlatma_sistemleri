import "server-only";
import { lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Health geçmişi (`device_health_log`) — admin'in cihaz "Kayıtlar" sekmesi ve
 * indirme için. `devices.health` yalnızca son mesajı tuttuğundan her `/health`
 * ayrıca buraya eklenir. Müşteriye gösterilmez.
 *
 * Saklama: 7 gün. Ayrı zamanlayıcı yok — temizlik saatte en fazla bir kez,
 * bir health yazımının ardından çalışır (DB zaten health yüzünden uyanık;
 * Neon'u ekstra uyandırmaz).
 */
export const HEALTH_LOG_RETENTION_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const g = globalThis as unknown as { __fenerHealthPrune?: { lastAt: number; running: boolean } };
const prune = (g.__fenerHealthPrune ??= { lastAt: 0, running: false });

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
  void pruneHealthLog(at.getTime());
}

async function pruneHealthLog(nowMs: number): Promise<void> {
  if (prune.running || nowMs - prune.lastAt < PRUNE_EVERY_MS) return;
  prune.running = true;
  prune.lastAt = nowMs;
  try {
    const cutoff = new Date(nowMs - HEALTH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(schema.deviceHealthLog).where(lt(schema.deviceHealthLog.recordedAt, cutoff));
  } catch (err) {
    console.warn("[healthLog] temizlik başarısız:", (err as Error).message);
  } finally {
    prune.running = false;
  }
}
