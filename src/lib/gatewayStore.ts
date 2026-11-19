import "server-only";
import { and, asc, count, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toGatewayView, type ThreadDevice } from "@/lib/adapters";
import type { GatewayView } from "@/app/_lib/types";

/**
 * Bir müşterinin gateway'leri (bölge adı + bağlı cihaz sayısıyla). `gatewayId`
 * verilirse yalnızca o gateway. Bağlı cihaz sayısı yalnızca bu müşterinin
 * cihazlarından sayılır (bağ: lib/gatewayLink.ts, Thread partition eşleşmesi).
 */
export async function listGateways(
  customerId: string,
  opts: { technical: boolean; gatewayId?: string },
): Promise<GatewayView[]> {
  const rows = await db
    .select({ g: schema.gateways, zoneSlug: schema.zones.slug, zoneName: schema.zones.name })
    .from(schema.gateways)
    .leftJoin(schema.zones, eq(schema.gateways.zoneId, schema.zones.id))
    .where(
      and(
        eq(schema.gateways.customerId, customerId),
        opts.gatewayId ? eq(schema.gateways.gatewayId, opts.gatewayId) : undefined,
      ),
    )
    .orderBy(asc(schema.gateways.name), asc(schema.gateways.gatewayId));
  if (rows.length === 0) return [];

  const counts = await db
    .select({ gatewayId: schema.devices.gatewayId, n: count() })
    .from(schema.devices)
    .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
    .where(and(eq(schema.zones.customerId, customerId), isNotNull(schema.devices.gatewayId)))
    .groupBy(schema.devices.gatewayId);
  const byGw = new Map(counts.map((c) => [c.gatewayId, c.n]));

  // Topoloji (yalnızca admin): RLOC16 → lamba adı. Lambanın Thread kimliği son
  // health'inden (binary firmware her health'te yazar).
  const threadDevices: ThreadDevice[] = [];
  if (opts.technical && rows.some((r) => r.g.report)) {
    const rloc = sql<string | null>`${schema.devices.health} -> 'thread' ->> 'rloc16'`;
    const devs = await db
      .select({
        mac: schema.devices.deviceId,
        name: schema.devices.name,
        rloc16: rloc,
        partitionId: sql<string | null>`${schema.devices.health} -> 'thread' ->> 'partition_id'`,
      })
      .from(schema.devices)
      .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(and(eq(schema.zones.customerId, customerId), sql`${rloc} IS NOT NULL`));
    for (const d of devs) {
      const n = Number(d.rloc16);
      if (Number.isInteger(n)) threadDevices.push({ mac: d.mac, name: d.name, rloc16: n, partitionId: d.partitionId });
    }
  }

  return rows.map((r) =>
    toGatewayView(
      {
        ...r.g,
        zoneSlug: r.zoneSlug,
        zoneName: r.zoneName,
        deviceCount: byGw.get(r.g.gatewayId) ?? 0,
      },
      opts.technical,
      threadDevices,
    ),
  );
}

/**
 * Gateway'in konum etiketi olacak bölge: müşterinin bölgesi olmalı.
 * Boş slug → bağ kaldırılır (null). Bulunamazsa undefined.
 */
export async function resolveGatewayZone(
  customerId: string,
  zoneSlug: string,
): Promise<string | null | undefined> {
  if (zoneSlug === "") return null;
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(and(eq(schema.zones.slug, zoneSlug), eq(schema.zones.customerId, customerId)))
    .limit(1);
  return zone?.id;
}
