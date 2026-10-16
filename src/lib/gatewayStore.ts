import "server-only";
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toGatewayView } from "@/lib/adapters";
import type { GatewayView } from "@/app/_lib/types";

/**
 * Bir müşterinin gateway'leri (bölge adı + bağlı cihaz sayısıyla). `gatewayId`
 * verilirse yalnızca o gateway. Bağlı cihaz sayısı yalnızca bu müşterinin
 * cihazlarından sayılır.
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

  return rows.map((r) =>
    toGatewayView(
      {
        ...r.g,
        zoneSlug: r.zoneSlug,
        zoneName: r.zoneName,
        deviceCount: byGw.get(r.g.gatewayId) ?? 0,
      },
      opts.technical,
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
