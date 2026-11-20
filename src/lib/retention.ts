import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Cihaz kayıtlarının saklama süresi: telemetri (`d4i_telemetry`) ile health/RF
 * geçmişi (`device_health_log`) **90 gün** (3 ay) tutulur, eskisi silinir.
 *
 * Ayrı zamanlayıcı yok: temizlik tablo başına saatte en fazla bir kez, o
 * tabloya yapılan bir yazımın ardından çalışır (DB zaten yazım yüzünden
 * uyanık; Neon'u ekstra uyandırmaz). Silme `BATCH` satırlık parçalarla yapılır
 * — ilk çalışmada aylarca birikmiş satır tek dev DELETE'le kilitlenmesin.
 *
 * Raporlar en fazla 31 gün + 2 gün geriye baktığı için 90 gün onları etkilemez.
 */
export const RECORD_RETENTION_DAYS = 90;

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const BATCH = 5000;
/** Tek temizlik turunda en fazla bu kadar parça (kalan sonraki tura kalır). */
const MAX_BATCHES = 40;

type Table = "d4i_telemetry" | "device_health_log";

const g = globalThis as unknown as {
  __fenerRetention?: Record<Table, { lastAt: number; running: boolean }>;
};
const state = (g.__fenerRetention ??= {
  d4i_telemetry: { lastAt: 0, running: false },
  device_health_log: { lastAt: 0, running: false },
});

/** Yazımdan sonra çağrılır; saatte bir kez eski satırları siler. Hata yalnızca log'lanır. */
export function pruneOldRecords(table: Table, nowMs: number = Date.now()): void {
  const s = state[table];
  if (s.running || nowMs - s.lastAt < PRUNE_EVERY_MS) return;
  s.running = true;
  s.lastAt = nowMs;
  void run(table, new Date(nowMs - RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000)).finally(() => {
    s.running = false;
  });
}

async function run(table: Table, cutoff: Date): Promise<void> {
  const t = sql.identifier(table);
  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const res = await db.execute(sql`
        DELETE FROM ${t} WHERE id IN (
          SELECT id FROM ${t} WHERE recorded_at < ${cutoff} LIMIT ${BATCH}
        )`);
      const deleted = res.rowCount ?? 0;
      if (deleted < BATCH) return;
    }
  } catch (err) {
    console.warn(`[retention] ${table} temizliği başarısız:`, (err as Error).message);
  }
}
