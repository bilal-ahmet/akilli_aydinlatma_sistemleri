import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import type { OpenFault } from "@/app/_lib/types";

export const runtime = "nodejs";

/**
 * GET /api/faults → O AN süren (resolved_at IS NULL) lamba arızaları, cihaz ve
 * bölge bilgisiyle. Dashboard bölge kartlarında "hangi cihaz/lamba" detayını,
 * cihaz listesinde ise arıza rozetini bundan besler.
 *
 * Yalnızca `channel` taşıyan (lamba/donanım) arızalar döner; cihaz seviyesi
 * komut hataları (`channel = NULL`) hariç tutulur — onlar zaten
 * `devices.last_error` üzerinden "komut hatası" olarak gösteriliyor.
 */
export async function GET() {
  try {
    const rows = await db
      .select({
        deviceId: schema.faultEvents.deviceId,
        channel: schema.faultEvents.channel,
        code: schema.faultEvents.code,
        detail: schema.faultEvents.detail,
        startedAt: schema.faultEvents.startedAt,
        deviceName: schema.devices.name,
        zoneSlug: schema.zones.slug,
        zoneName: schema.zones.name,
      })
      .from(schema.faultEvents)
      .leftJoin(schema.devices, eq(schema.faultEvents.deviceId, schema.devices.deviceId))
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(
        and(
          isNull(schema.faultEvents.resolvedAt),
          isNotNull(schema.faultEvents.channel),
        ),
      )
      .orderBy(desc(schema.faultEvents.startedAt));

    const faults: OpenFault[] = rows.map((r) => ({
      deviceId: r.deviceId,
      deviceName: r.deviceName ?? null,
      zoneSlug: r.zoneSlug ?? null,
      zoneName: r.zoneName ?? null,
      channel: r.channel,
      code: r.code,
      detail: r.detail,
      startedAt: r.startedAt.toISOString(),
    }));
    return ok(faults);
  } catch (err) {
    return fail("Arızalar okunamadı", 500, String(err));
  }
}
