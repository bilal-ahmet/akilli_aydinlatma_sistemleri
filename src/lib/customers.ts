import "server-only";
import { count, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { computeSummary } from "@/lib/summary";
import { onlineWindowMs } from "@/lib/deviceWindows";
import { getTenancy } from "@/lib/tenancy";
import type { CustomerOverview } from "@/types/admin";

/**
 * Admin müşteri listesi: her müşteri için sayılar + ölçülmüş özet.
 * Bölge/cihaz sayıları tenancy index'inden, kullanıcı sayısı tek gruplu
 * sorgudan; çevrimiçi cihaz panelle aynı kuralla (cihaz başına pencere,
 * lib/deviceWindows.ts) sayılır. Güç/arıza özeti müşteri başına
 * `computeSummary` ile gelir (müşteri sayısı küçük; paralel çalışır).
 */
export async function listCustomerOverviews(): Promise<CustomerOverview[]> {
  const idx = await getTenancy();
  const rows = await db.select().from(schema.customers).orderBy(schema.customers.name);
  if (rows.length === 0) return [];

  const [seen, userCounts] = await Promise.all([
    db
      .select({
        customerId: schema.zones.customerId,
        lastSeen: schema.devices.lastSeen,
        healthIntervalS: schema.devices.healthIntervalS,
        reportIntervalS: schema.devices.reportIntervalS,
      })
      .from(schema.devices)
      .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(isNotNull(schema.devices.lastSeen)),
    db
      .select({ customerId: schema.users.customerId, n: count() })
      .from(schema.users)
      .where(inArray(schema.users.customerId, rows.map((r) => r.id)))
      .groupBy(schema.users.customerId),
  ]);
  const now = Date.now();
  const onlineBy = new Map<string, number>();
  for (const d of seen) {
    if (!d.lastSeen || now - d.lastSeen.getTime() >= onlineWindowMs(d)) continue;
    onlineBy.set(d.customerId, (onlineBy.get(d.customerId) ?? 0) + 1);
  }
  const usersBy = new Map(userCounts.map((u) => [u.customerId, Number(u.n)]));

  const summaries = await Promise.all(
    rows.map((r) => computeSummary(idx.customersById.get(r.id)?.macs ?? [])),
  );

  return rows.map((r, i) => {
    const info = idx.customersById.get(r.id);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      isActive: r.isActive,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      notes: r.notes,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      zoneCount: info?.zoneSlugs.length ?? 0,
      deviceCount: info?.macs.length ?? 0,
      onlineDevices: onlineBy.get(r.id) ?? 0,
      userCount: usersBy.get(r.id) ?? 0,
      summary: summaries[i],
    };
  });
}
