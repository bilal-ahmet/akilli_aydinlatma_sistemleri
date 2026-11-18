import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { getTenancy } from "@/lib/tenancy";
import { zoneSyncView } from "@/lib/zoneSync/engine";
import { ZONES_PER_DEVICE } from "@/lib/zoneSync/plan";
import type { ZoneGroupView } from "@/app/_lib/types";

/**
 * Alt gruplar (bölgenin cihazlarından oluşan ek topic'ler). Ad DB'den, üyeler
 * ve senkron durumu bellekten (tenancy + lib/zoneSync) okunur.
 */
export async function listZoneGroups(zoneSlug: string): Promise<ZoneGroupView[]> {
  const rows = await db
    .select({ slug: schema.zoneGroups.slug, name: schema.zoneGroups.name })
    .from(schema.zoneGroups)
    .innerJoin(schema.zones, eq(schema.zoneGroups.zoneId, schema.zones.id))
    .where(eq(schema.zones.slug, zoneSlug))
    .orderBy(asc(schema.zoneGroups.name));
  const idx = await getTenancy();
  return rows.map((r) => {
    const members = idx.groupMacs.get(r.slug) ?? [];
    return {
      slug: r.slug,
      name: r.name,
      zoneSlug,
      members: [...members],
      synced: members.filter((mac) => zoneSyncView(mac).status === "synced").length,
    };
  });
}

/**
 * Cihaz başına en fazla 16 topic dinlenebilir (firmware): bölge + 15 alt grup.
 */
export const GROUPS_PER_DEVICE = ZONES_PER_DEVICE - 1;
