import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";

/**
 * Arıza geçmişini (`fault_events`) güncel duruma göre senkronlar: yalnızca
 * DEĞİŞİMDE yazar — yeni görülen kod için satır açar, artık görülmeyen açık
 * satırı kapatır. Cihaz aynı arızayı 30 sn'de bir raporladığında tabloya
 * hiçbir şey yazılmaz.
 *
 * `channel: null` → cihaz seviyesi (komut hatası); o hedefteki açık kayıtlar
 * ayrı bir küme olarak yönetilir, lamba arızalarına dokunmaz.
 */
export async function syncFaultEvents(
  deviceId: string,
  channel: number | null,
  active: Array<{ code: string; detail?: string }>,
  now: Date,
): Promise<void> {
  const scope = and(
    eq(schema.faultEvents.deviceId, deviceId),
    channel === null
      ? isNull(schema.faultEvents.channel)
      : eq(schema.faultEvents.channel, channel),
    isNull(schema.faultEvents.resolvedAt),
  );

  const open = await db
    .select({ id: schema.faultEvents.id, code: schema.faultEvents.code })
    .from(schema.faultEvents)
    .where(scope);

  const openCodes = new Set(open.map((r) => r.code));
  const activeCodes = new Set(active.map((a) => a.code));

  const toOpen = active.filter((a) => !openCodes.has(a.code));
  if (toOpen.length > 0) {
    await db.insert(schema.faultEvents).values(
      toOpen.map((a) => ({
        deviceId,
        channel,
        code: a.code,
        detail: a.detail?.slice(0, 300) ?? null,
        startedAt: now,
      })),
    );
  }

  const toClose = open.filter((r) => !activeCodes.has(r.code)).map((r) => r.id);
  if (toClose.length > 0) {
    await db
      .update(schema.faultEvents)
      .set({ resolvedAt: now })
      .where(inArray(schema.faultEvents.id, toClose));
  }
}
