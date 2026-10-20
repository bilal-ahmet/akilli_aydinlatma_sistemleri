import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { runPlan, type PlanOp } from "@/lib/commandPlan";
import { getTenancy } from "@/lib/tenancy";
import {
  SCHEDULE_GRACE_MS,
  nextRunAt,
  specOf,
  type ScheduleResult,
} from "@/lib/scheduleTime";
import type { ScheduleRow } from "@/lib/db/schema";

/**
 * Zamanlanmış komutların sunucu tarafı zamanlayıcısı (globalThis singleton).
 *
 * - Bellekte etkin zamanlamaların `next_run_at`'leri tutulur; en yakına TEK
 *   `setTimeout` kurulur (en fazla 6 sa, sonra yeniden kurulur). DB yoklanmaz:
 *   Neon yalnızca açılışta, CRUD'da (`reloadSchedules`) ve çalıştırmada uyanır.
 * - Çalıştırma atomik claim ile yapılır (`UPDATE … WHERE next_run_at =
 *   <beklenen>`): Railway deploy'unda eski/yeni instance kısa süre birlikte
 *   yaşar, iki tarafın da zamanlayıcısı kurulu olsa bile komut bir kez gider.
 * - Sunucu kapalıyken zamanı geçen çalışma `SCHEDULE_GRACE_MS` içindeyse
 *   hemen çalıştırılır; daha eskiyse `missed` yazılıp sonraki zamana geçilir
 *   (gece 03:00'te "18:30 Aç" çalışmasın).
 *
 * Tek instance varsayımı (Kural #8) yalnızca bellek haritası için geçerlidir;
 * çift çalıştırmayı claim önler.
 */

const MAX_DELAY_MS = 6 * 60 * 60_000;

type Entry = { nextRunAt: number };
type State = {
  entries: Map<string, Entry>;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rearm: boolean;
};

const g = globalThis as unknown as { __fenerScheduler?: State };
const state: State = (g.__fenerScheduler ??= {
  entries: new Map(),
  timer: null,
  running: false,
  rearm: false,
});

function opOf(row: ScheduleRow): PlanOp {
  switch (row.action) {
    case "stop_fx":
      return { kind: "stop_fx" };
    case "on":
      // Şiddet seçilmişse "o şiddette aç" = dim.
      return { kind: "command", cmd: row.value != null ? { action: "dim", value: row.value } : { action: "on" } };
    case "off":
      return { kind: "command", cmd: { action: "off" } };
    case "dim":
      return { kind: "command", cmd: { action: "dim", value: row.value ?? 100 } };
    default:
      return {
        kind: "command",
        cmd: {
          action: "efekt",
          number: row.effectNumber ?? 1,
          ...(row.effectText ? { text: row.effectText } : {}),
        },
      };
  }
}

/** Haritayı DB'den yeniden kurar ve zamanlayıcıyı yeniden ayarlar. CRUD sonrası beklenir. */
export async function reloadSchedules(): Promise<void> {
  const rows = await db
    .select({ id: schema.schedules.id, enabled: schema.schedules.enabled, nextRunAt: schema.schedules.nextRunAt })
    .from(schema.schedules);
  state.entries = new Map(
    rows
      .filter((r) => r.enabled && r.nextRunAt)
      .map((r) => [r.id, { nextRunAt: r.nextRunAt!.getTime() }]),
  );
  arm();
}

/** Açılışta (instrumentation) çağrılır. Hata sunucuyu düşürmez. */
export async function startScheduler(): Promise<void> {
  await reloadSchedules();
  console.log(`[schedule] zamanlayıcı başladı (${state.entries.size} etkin zamanlama)`);
}

function arm(): void {
  if (state.running) {
    state.rearm = true;
    return;
  }
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  let next = Infinity;
  for (const e of state.entries.values()) next = Math.min(next, e.nextRunAt);
  if (next === Infinity) return;
  const delay = Math.min(Math.max(next - Date.now(), 0), MAX_DELAY_MS);
  state.timer = setTimeout(() => void tick(), delay);
  state.timer.unref?.();
}

async function tick(): Promise<void> {
  state.timer = null;
  state.running = true;
  try {
    const now = Date.now();
    const due = [...state.entries]
      .filter(([, e]) => e.nextRunAt <= now + 500)
      .sort((a, b) => a[1].nextRunAt - b[1].nextRunAt);
    for (const [id, e] of due) {
      try {
        const next = await runOne(id, e.nextRunAt);
        if (next == null) state.entries.delete(id);
        else state.entries.set(id, { nextRunAt: next });
      } catch (err) {
        console.error(`[schedule] ${id} çalıştırılamadı:`, err);
        // Aynı anı sonsuza dek yeniden denememek için haritadan düşür;
        // sonraki CRUD/yeniden başlatma DB'den tekrar yükler.
        state.entries.delete(id);
      }
    }
  } finally {
    state.running = false;
    state.rearm = false;
    arm();
  }
}

/**
 * Tek zamanlamayı claim edip çalıştırır. Döner: haritadaki yeni
 * `next_run_at` (ms) ya da artık çalışmayacaksa null.
 */
async function runOne(id: string, expected: number): Promise<number | null> {
  const [row] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
  if (!row || !row.enabled || !row.nextRunAt) return null;
  if (row.nextRunAt.getTime() !== expected) return row.nextRunAt.getTime(); // başka yerde değişti

  const now = new Date();
  const missed = now.getTime() - expected > SCHEDULE_GRACE_MS;
  const next = nextRunAt(specOf(row), new Date(Math.max(now.getTime(), expected)));
  const claimed = await db
    .update(schema.schedules)
    .set({
      nextRunAt: next,
      lastRunAt: missed ? new Date(expected) : now,
      lastResult: missed ? { sent: 0, skipped: 0, missed: true } : null,
    })
    .where(
      and(
        eq(schema.schedules.id, id),
        eq(schema.schedules.enabled, true),
        eq(schema.schedules.nextRunAt, row.nextRunAt),
      ),
    )
    .returning({ id: schema.schedules.id });
  if (claimed.length === 0) return null; // başka instance aldı ya da kapatıldı
  if (missed) {
    console.warn(`[schedule] ${id} kaçırıldı (${new Date(expected).toISOString()}), atlandı`);
    return next?.getTime() ?? null;
  }

  let result: ScheduleResult;
  const customer = (await getTenancy()).customersById.get(row.customerId);
  if (!customer) {
    result = { sent: 0, skipped: 0, error: "Müşteri bulunamadı" };
  } else {
    try {
      result = await runPlan(customer, row.target, opOf(row), {
        userId: row.createdBy,
        customerId: row.customerId,
      });
    } catch (err) {
      console.error(`[schedule] ${id} komutları gönderilemedi:`, err);
      result = { sent: 0, skipped: 0, error: "Komut gönderilemedi" };
    }
  }
  await db
    .update(schema.schedules)
    .set({ lastResult: result })
    .where(eq(schema.schedules.id, id))
    .catch((err) => console.error(`[schedule] ${id} sonucu yazılamadı:`, err));
  console.log(`[schedule] ${id} çalıştı: ${result.sent} komut, ${result.skipped} atlandı`);
  return next?.getTime() ?? null;
}
