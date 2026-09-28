import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import type { FaultRecord, OpenFault } from "@/app/_lib/types";

export const runtime = "nodejs";

/**
 * GET /api/faults?customer=<slug> → müşterinin O AN süren (resolved_at IS
 * NULL) lamba arızaları, cihaz ve bölge bilgisiyle. Dashboard bölge
 * kartlarında "hangi cihaz/lamba" detayını, cihaz listesinde ise arıza
 * rozetini bundan besler.
 *
 * Yalnızca `channel` taşıyan (lamba/donanım) arızalar döner; cihaz seviyesi
 * komut hataları (`channel = NULL`) hariç tutulur — onlar zaten
 * `devices.last_error` üzerinden "komut hatası" olarak gösteriliyor.
 *
 * `?days=N` (1-90) → arızalar sayfasının geçmişi: süren arızalara ek olarak
 * son N günde ÇÖZÜLMÜŞ olanlar da `FaultRecord` (id + resolvedAt) olarak döner.
 */
const MAX_HISTORY_DAYS = 90;

export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;

  const daysParam = new URL(req.url).searchParams.get("days");
  const days = daysParam === null ? null : Number(daysParam);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_HISTORY_DAYS)) {
    return fail(`days 1-${MAX_HISTORY_DAYS} arası bir tam sayı olmalı`, 422);
  }
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000);

  try {
    const rows = await db
      .select({
        id: schema.faultEvents.id,
        resolvedAt: schema.faultEvents.resolvedAt,
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
      .innerJoin(schema.devices, eq(schema.faultEvents.deviceId, schema.devices.deviceId))
      .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(
        and(
          eq(schema.zones.customerId, ctx.customer.id),
          since
            ? or(isNull(schema.faultEvents.resolvedAt), gt(schema.faultEvents.resolvedAt, since))
            : isNull(schema.faultEvents.resolvedAt),
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
    if (!since) return ok(faults);
    const history: FaultRecord[] = faults.map((f, i) => ({
      ...f,
      id: rows[i].id,
      resolvedAt: rows[i].resolvedAt ? rows[i].resolvedAt!.toISOString() : null,
    }));
    return ok(history);
  } catch (err) {
    return fail("Arızalar okunamadı", 500, String(err));
  }
}
