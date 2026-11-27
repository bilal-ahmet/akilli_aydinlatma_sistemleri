import "server-only";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { onlineWindowMs } from "@/lib/deviceWindows";
import { gatewayOnlineWindowMs, gatewayState } from "@/lib/gateways";
import {
  buildMeshTopology,
  hex16,
  type MeshDeviceInput,
  type MeshGatewayInput,
  type MeshNode,
} from "./build";
import { suggestMesh } from "./suggest";
import { healthEvents, type HealthChangeRow } from "./events";
import type { DeviceMeshView, MeshSeries, MeshView } from "./view";

export type { DeviceMeshView, MeshSeries, MeshView } from "./view";

/**
 * Ağ haritası verisi (yalnızca admin): müşterinin cihaz + gateway health'lerinden
 * rota ağacı, öneriler, son 24 sa ağ olayları ve KPI serileri.
 *
 * `device_health_log` satırları uygulamaya çekilmez: 24 sa özetleri, değişim
 * satırları (LAG) ve saatlik seriler SQL'de hesaplanır. Sonuç müşteri başına
 * 30 sn bellekte tutulur (sayfa 60 sn'de bir yeniler; Neon'u uyanık tutmasın).
 */


const CACHE_MS = 30_000;
const EVENT_LIMIT = 200;
const cache = new Map<string, { at: number; view: MeshView }>();

/** Gateway'in konumu/adı değişince önbellek boşaltılır (yeniden çizim hemen). */
export function forgetMeshCache(customerId?: string) {
  if (customerId) cache.delete(customerId);
  else cache.clear();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** health.thread → rota ve link alanları. */
export function threadFields(health: Record<string, unknown> | null) {
  const t = obj(health?.thread);
  const nextHop = num(t?.route_next_hop);
  const neighbors = Array.isArray(t?.neighbors) ? (t!.neighbors as unknown[]).map(obj).filter((x) => x !== null) : [];
  const nb = nextHop !== null ? neighbors.find((x) => num(x!.rloc16) === nextHop) : undefined;
  return {
    rloc16: num(t?.rloc16),
    partitionId: text(t?.partition_id),
    role: typeof t?.role === "string" ? t.role : null,
    nextHop,
    pathCost: num(t?.route_path_cost),
    parentRssiAvg: num(t?.parent_rssi_avg_dbm),
    parentRssiLast: num(t?.parent_rssi_last_dbm),
    lqIn: num(t?.parent_link_quality_in),
    lqOut: num(t?.parent_link_quality_out),
    linkMargin: nb ? num(nb.link_margin) : null,
    parentChanges: num(t?.parent_changes),
    neighbors: neighbors.map((x) => ({
      rloc16: num(x!.rloc16),
      role: typeof x!.role === "string" ? x!.role : null,
      rssiAvg: num(x!.rssi_avg_dbm),
      rssiLast: num(x!.rssi_last_dbm),
      linkMargin: num(x!.link_margin),
      lqIn: num(x!.link_quality_in),
    })),
  };
}

/** device_health_log'un son 24 sa'i, cihaz başına önceki satırla (LAG). */
function windowCte(macs: string[], hours = 24) {
  const t = schema.deviceHealthLog;
  return sql`
    WITH h AS (
      SELECT ${t.deviceId} AS mac, ${t.recordedAt} AS at,
             (${t.health} -> 'thread' ->> 'route_next_hop')::numeric::int AS nh,
             (${t.health} -> 'thread' ->> 'route_path_cost')::numeric::int AS cost,
             (${t.health} -> 'thread' ->> 'parent_changes')::numeric::int AS pch,
             (${t.health} -> 'thread' ->> 'parent_rssi_avg_dbm')::numeric::int AS rssi,
             (${t.health} -> 'thread' ->> 'partition_id') AS part
        FROM ${t}
       WHERE ${inArray(t.deviceId, macs)}
         AND ${t.recordedAt} > now() - make_interval(hours => ${hours})
    ), d AS (
      SELECT h.*,
             lag(nh)   OVER w AS p_nh,
             lag(cost) OVER w AS p_cost,
             lag(pch)  OVER w AS p_pch,
             lag(rssi) OVER w AS p_rssi,
             lag(part) OVER w AS p_part
        FROM h WINDOW w AS (PARTITION BY mac ORDER BY at)
    )`;
}

async function loadHistory(macs: string[]) {
  const agg = new Map<string, { rssiAvg: number | null; pc: number }>();
  const changes: HealthChangeRow[] = [];
  const series: MeshSeries = { hours: [], parentChanges: [], avgPathCost: [] };
  if (macs.length === 0) return { agg, changes, series };

  const [aggRes, chRes, serRes] = await Promise.all([
    db.execute<{ mac: string; rssi_avg: string | null; pc: string | null }>(sql`
      ${windowCte(macs)}
      SELECT mac, avg(rssi) AS rssi_avg, sum(GREATEST(pch - p_pch, 0)) AS pc
        FROM d GROUP BY mac`),
    db.execute<Record<string, unknown>>(sql`
      ${windowCte(macs)}
      SELECT mac, at, nh, p_nh, cost, p_cost, pch, p_pch, rssi, p_rssi, part, p_part
        FROM d
       WHERE (p_nh IS NOT NULL AND nh IS DISTINCT FROM p_nh)
          OR (p_cost IS NOT NULL AND cost IS DISTINCT FROM p_cost)
          OR (p_pch IS NOT NULL AND pch > p_pch)
          OR (p_rssi IS NOT NULL AND p_rssi - rssi >= 5)
          OR (p_part IS NOT NULL AND part IS DISTINCT FROM p_part)
       ORDER BY at DESC
       LIMIT ${EVENT_LIMIT}`),
    db.execute<{ hr: string | Date; cost: string | null; pc: string | null }>(sql`
      ${windowCte(macs)}
      SELECT date_trunc('hour', at) AS hr, avg(cost) AS cost, sum(GREATEST(pch - p_pch, 0)) AS pc
        FROM d GROUP BY 1 ORDER BY 1`),
  ]);

  for (const r of aggRes.rows) agg.set(r.mac, { rssiAvg: toNum(r.rssi_avg), pc: toNum(r.pc) ?? 0 });
  for (const r of chRes.rows) {
    changes.push({
      mac: String(r.mac),
      at: iso(r.at),
      nextHop: toNum(r.nh),
      prevNextHop: toNum(r.p_nh),
      pathCost: toNum(r.cost),
      prevPathCost: toNum(r.p_cost),
      parentChanges: toNum(r.pch),
      prevParentChanges: toNum(r.p_pch),
      rssi: toNum(r.rssi),
      prevRssi: toNum(r.p_rssi),
      partition: r.part == null ? null : String(r.part),
      prevPartition: r.p_part == null ? null : String(r.p_part),
    });
  }
  // 24 saat başlığı; boş saatler 0 / null.
  const byHour = new Map(serRes.rows.map((r) => [iso(r.hr), r]));
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i--) {
    const h = new Date(start.getTime() - i * 3_600_000).toISOString();
    const r = byHour.get(h);
    series.hours.push(h);
    series.parentChanges.push(toNum(r?.pc) ?? 0);
    const c = toNum(r?.cost);
    series.avgPathCost.push(c === null ? null : Math.round(c * 100) / 100);
  }
  return { agg, changes, series };
}

export async function loadMesh(customerId: string): Promise<MeshView> {
  const hit = cache.get(customerId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.view;

  const d = schema.devices;
  const [rows, gwRows] = await Promise.all([
    db
      .select({
        mac: d.deviceId,
        name: d.name,
        lastSeen: d.lastSeen,
        health: d.health,
        healthAt: d.healthAt,
        healthIntervalS: d.healthIntervalS,
        reportIntervalS: d.reportIntervalS,
        poleId: d.poleId,
        poleCode: schema.poles.code,
        lat: schema.poles.lat,
        lng: schema.poles.lng,
        zoneSlug: schema.zones.slug,
      })
      .from(d)
      .innerJoin(schema.zones, eq(d.zoneId, schema.zones.id))
      .leftJoin(schema.poles, eq(d.poleId, schema.poles.id))
      .where(eq(schema.zones.customerId, customerId)),
    db
      .select({
        gatewayId: schema.gateways.gatewayId,
        name: schema.gateways.name,
        type: schema.gateways.type,
        lat: schema.gateways.lat,
        lng: schema.gateways.lng,
        online: schema.gateways.online,
        lastSeen: schema.gateways.lastSeen,
        health: schema.gateways.health,
        report: schema.gateways.report,
      })
      .from(schema.gateways)
      .where(eq(schema.gateways.customerId, customerId)),
  ]);

  const macs = rows.map((r) => r.mac);
  const [lampRows, history] = await Promise.all([
    macs.length
      ? db
          .select({ mac: schema.fixtures.deviceId, n: count() })
          .from(schema.fixtures)
          .where(and(inArray(schema.fixtures.deviceId, macs)))
          .groupBy(schema.fixtures.deviceId)
      : Promise.resolve([] as { mac: string; n: number }[]),
    loadHistory(macs),
  ]);
  const lamps = new Map(lampRows.map((r) => [r.mac, Number(r.n)]));

  const now = Date.now();
  const devices: MeshDeviceInput[] = rows.map((r) => {
    const t = threadFields(r.health);
    const windowMs = onlineWindowMs({ healthIntervalS: r.healthIntervalS, reportIntervalS: r.reportIntervalS });
    const h = history.agg.get(r.mac);
    return {
      mac: r.mac,
      name: r.name,
      poleId: r.poleId,
      poleCode: r.poleCode,
      zoneSlug: r.zoneSlug,
      lat: r.lat,
      lng: r.lng,
      online: r.lastSeen !== null && now - r.lastSeen.getTime() < windowMs,
      healthAt: r.healthAt ? r.healthAt.toISOString() : null,
      rloc16: t.rloc16,
      partitionId: t.partitionId,
      role: t.role,
      nextHop: t.nextHop,
      pathCost: t.pathCost,
      parentRssiAvg: t.parentRssiAvg,
      parentRssiLast: t.parentRssiLast,
      lqIn: t.lqIn,
      lqOut: t.lqOut,
      linkMargin: t.linkMargin,
      lampCount: lamps.get(r.mac) ?? 0,
      reportIntervalS: r.reportIntervalS,
      healthIntervalS: r.healthIntervalS,
      parentChanges24h: h ? h.pc : null,
      rssiAvg24h: h ? h.rssiAvg : null,
    };
  });

  const gateways: MeshGatewayInput[] = gwRows
    .filter((g) => g.type === "thread_br")
    .map((g) => {
      const t = obj(g.health?.thread);
      const nb = obj(obj(g.report)?.neighbors);
      const items = Array.isArray(nb?.items) ? (nb!.items as unknown[]).map(obj) : [];
      return {
        gatewayId: g.gatewayId,
        name: g.name,
        rloc16: num(t?.rloc16),
        partitionId: text(t?.partition_id),
        lat: g.lat,
        lng: g.lng,
        online:
          gatewayState(
            {
              lastSeen: g.lastSeen ? g.lastSeen.toISOString() : null,
              online: g.online,
              onlineWindowMs: gatewayOnlineWindowMs(g.health),
            },
            now,
          ) === "online",
        neighborErrors: items
          .filter((x): x is Record<string, unknown> => x !== null && num(x.rloc16) !== null)
          .map((x) => ({ rloc16: num(x.rloc16)!, frameErrorPct: num(x.frame_error_pct) })),
      };
    });

  const topo = buildMeshTopology(devices, gateways);
  const byKey = new Map<string, string>();
  for (const n of topo.nodes) {
    if (n.rloc16 !== null && n.kind !== "unknown") byKey.set(`${n.partitionId ?? "?"}:${n.rloc16}`, n.label);
  }
  const nameOf = (rloc: number, partition: string | null) =>
    byKey.get(`${partition ?? "?"}:${rloc}`) ??
    [...byKey.entries()].find(([k]) => k.endsWith(`:${rloc}`))?.[1] ??
    hex16(rloc);
  const pc24 = new Map([...history.agg.entries()].map(([m, a]) => [m, a.pc]));

  const view: MeshView = {
    at: new Date(now).toISOString(),
    nodes: topo.nodes,
    kpi: topo.kpi,
    suggestions: suggestMesh(topo.nodes),
    events: healthEvents(history.changes, nameOf, pc24).slice(0, EVENT_LIMIT),
    series: history.series,
  };
  cache.set(customerId, { at: now, view });
  return view;
}


/** Cihaz modalı "Ağ" sekmesi: müşterinin ağacından cihazın yolu + 24 sa saatlik seri. */
export async function loadDeviceMesh(customerId: string, mac: string): Promise<DeviceMeshView> {
  const mesh = await loadMesh(customerId);
  const byId = new Map(mesh.nodes.map((n) => [n.id, n]));
  const node = byId.get(mac) ?? null;

  const path: DeviceMeshView["path"] = [];
  const seen = new Set<string>();
  for (let cur = node; cur && !seen.has(cur.id); cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null) {
    seen.add(cur.id);
    path.push({ id: cur.id, kind: cur.kind, label: cur.label, rloc16: cur.rloc16, pathCost: cur.pathCost, mac: cur.mac });
  }

  const [row] = await db
    .select({ health: schema.devices.health })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, mac));
  const t = threadFields(row?.health ?? null);
  const byRloc = new Map<number, MeshNode>();
  for (const n of mesh.nodes) {
    if (n.rloc16 === null || n.kind === "unknown") continue;
    if (n.partitionId !== null && t.partitionId !== null && n.partitionId !== t.partitionId) continue;
    if (n.id !== mac) byRloc.set(n.rloc16, n);
  }
  const neighbors = t.neighbors.map((x) => {
    const n = x.rloc16 !== null ? byRloc.get(x.rloc16) : undefined;
    return {
      rloc16: x.rloc16,
      label: n?.label ?? null,
      mac: n?.mac ?? null,
      role: x.role,
      rssiAvg: x.rssiAvg,
      linkMargin: x.linkMargin,
      lqIn: x.lqIn,
      isNextHop: x.rloc16 !== null && x.rloc16 === t.nextHop,
    };
  });

  const res = await db.execute<{ hr: string | Date; rssi: string | null; cost: string | null }>(sql`
    ${windowCte([mac])}
    SELECT date_trunc('hour', at) AS hr, avg(rssi) AS rssi, avg(cost) AS cost
      FROM d GROUP BY 1 ORDER BY 1`);
  const byHour = new Map(res.rows.map((r) => [iso(r.hr), r]));
  const series: DeviceMeshView["series"] = { hours: [], rssiAvg: [], pathCost: [] };
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i--) {
    const h = new Date(start.getTime() - i * 3_600_000).toISOString();
    const r = byHour.get(h);
    const rs = toNum(r?.rssi);
    const c = toNum(r?.cost);
    series.hours.push(h);
    series.rssiAvg.push(rs === null ? null : Math.round(rs * 10) / 10);
    series.pathCost.push(c === null ? null : Math.round(c * 100) / 100);
  }

  return {
    at: mesh.at,
    node,
    path,
    neighbors,
    routeSupported: t.nextHop !== null || t.pathCost !== null,
    series,
  };
}
