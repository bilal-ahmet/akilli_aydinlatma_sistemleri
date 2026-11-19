import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toD4iSnapshot } from "@/lib/adapters";
import { fail } from "@/lib/api/respond";
import { authorizeDevice } from "@/lib/auth/guard";
import { TELEMETRY_STALE_MS } from "@/lib/deviceWindows";
import type { D4iSnapshot, StaleTelemetry } from "@/app/_lib/types";

export const runtime = "nodejs";

/**
 * Kanal başına en güncel satırı bulmak için taranan son satır sayısı. Sık
 * rapor veren kanalların hepsi bu pencerede bulunur; bulunamayan (seyrek ya
 * da susmuş) kayıtlı kanal için ayrıca tek satırlık sorgu yapılır.
 */
const SCAN_LIMIT = 200;

type Row = typeof schema.d4iTelemetry.$inferSelect;

/**
 * GET /api/devices/:deviceId/telemetry → kayıtlı her armatürün son D4i raporu.
 *
 * - Yalnızca `fixtures`'ta kayıtlı kanallar döner: silinmiş armatürün eski
 *   telemetrisi `d4i_telemetry`'de (raporlar için) kalır ama panelde görünmez.
 *   Cihaz o adresi yeniden raporlarsa `upsertFixture` kaydı geri açar.
 * - Son raporu `TELEMETRY_STALE_MS`'ten (7 gün) eski armatürün ölçümleri
 *   `data`'ya girmez; `stale`'de yalnızca son rapor zamanı döner. Yeni rapor
 *   gelince kendiliğinden `data`'ya geri döner.
 *
 * Yanıt: `{ ok, data: D4iSnapshot[], stale: StaleTelemetry[] }` — `data`'nın
 * şekli değişmedi (mobil), `stale` ek alandır.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  const ctx = await authorizeDevice(req, deviceId, "read");
  if (ctx instanceof Response) return ctx;
  try {
    const fixtureRows = await db
      .select({ channel: schema.fixtures.channel })
      .from(schema.fixtures)
      .where(eq(schema.fixtures.deviceId, deviceId));
    const channels = new Set(fixtureRows.map((f) => f.channel));
    if (channels.size === 0) return respond([], []);

    const recent = await db
      .select()
      .from(schema.d4iTelemetry)
      .where(eq(schema.d4iTelemetry.deviceId, deviceId))
      .orderBy(desc(schema.d4iTelemetry.recordedAt))
      .limit(SCAN_LIMIT);

    // Satırlar yeniden eskiye sıralı — kanal başına ilk görülen en günceldir.
    const latest = new Map<number, Row>();
    for (const r of recent) {
      if (channels.has(r.channel) && !latest.has(r.channel)) latest.set(r.channel, r);
    }

    // Taramada çıkmayan kayıtlı kanallar: seyrek rapor veren ya da susmuş.
    const missing = [...channels].filter((ch) => !latest.has(ch));
    const found = await Promise.all(
      missing.map((ch) =>
        db
          .select()
          .from(schema.d4iTelemetry)
          .where(
            and(eq(schema.d4iTelemetry.deviceId, deviceId), eq(schema.d4iTelemetry.channel, ch)),
          )
          .orderBy(desc(schema.d4iTelemetry.recordedAt))
          .limit(1)
          .then((rows) => rows[0]),
      ),
    );
    for (const r of found) if (r) latest.set(r.channel, r);

    // Hiç raporu olmayan armatür (elle eklenmiş / D4i'siz) eskisi gibi listelenmez.
    const cutoff = Date.now() - TELEMETRY_STALE_MS;
    const fresh: D4iSnapshot[] = [];
    const stale: StaleTelemetry[] = [];
    for (const r of [...latest.values()].sort((a, b) => a.channel - b.channel)) {
      if (r.recordedAt && r.recordedAt.getTime() < cutoff) {
        stale.push({ channel: r.channel, lastReportAt: r.recordedAt.toISOString() });
      } else {
        fresh.push(toD4iSnapshot(r));
      }
    }
    return respond(fresh, stale);
  } catch (err) {
    return fail("Telemetri okunamadı", 500, String(err));
  }
}

/** `ok()` zarfı + ek `stale` alanı. */
function respond(data: D4iSnapshot[], stale: StaleTelemetry[]) {
  return NextResponse.json({ ok: true, data, stale });
}
