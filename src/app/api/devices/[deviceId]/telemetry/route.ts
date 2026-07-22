import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toD4iSnapshot } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

/**
 * Kanal (lamba) başına en güncel satırı bulmak için taranan satır sayısı.
 * Cihaz her adres için ~30 sn'de bir yayın yaptığından bu pencere en kötü
 * durumda bile tüm kanalların son raporunu kapsar.
 */
const SCAN_LIMIT = 200;

// GET /api/devices/:deviceId/telemetry → her DALI adresinin son D4i raporu.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  try {
    const rows = await db
      .select()
      .from(schema.d4iTelemetry)
      .where(eq(schema.d4iTelemetry.deviceId, deviceId))
      .orderBy(desc(schema.d4iTelemetry.recordedAt))
      .limit(SCAN_LIMIT);

    // Satırlar yeniden eskiye sıralı — kanal başına ilk görülen en günceldir.
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.channel)) latest.set(r.channel, r);

    return ok(
      [...latest.values()].sort((a, b) => a.channel - b.channel).map(toD4iSnapshot),
    );
  } catch (err) {
    return fail("Telemetri okunamadı", 500, String(err));
  }
}
