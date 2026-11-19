import "server-only";
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshMs } from "@/lib/deviceWindows";
import { REPORT_TZ, type ReportPeriod } from "./range";
import type { ReportDeviceRow, ReportEnergyRow, ReportFaultRow, ReportZoneRow } from "./build";

/**
 * Rapor sorguları. Hepsi müşteriye (ve istenirse tek bölgeye) kapsamlıdır:
 * cihaz listesi `zones.customer_id`'den gelir, arıza ve telemetri yalnızca bu
 * MAC'ler için okunur (Kural #12).
 */

/** Dönemin ilk sayaç farkı için dönemden önceki okumaya bakılan süre. */
const LOOKBACK_MS = 2 * 86_400_000;
/**
 * Bir armatürün makul en yüksek gücü (W). İki okuma arasındaki sayaç artışı
 * `geçen saat × bu değer`i aşıyorsa sıçrama sayılır (sürücü değişimi, bozuk
 * okuma) ve toplama girmez.
 */
const MAX_LAMP_W = 1000;

export interface ReportRows {
  zones: ReportZoneRow[];
  devices: ReportDeviceRow[];
  faults: ReportFaultRow[];
  energy: ReportEnergyRow[];
}

export async function loadReportRows(opts: {
  customerId: string;
  zoneSlug: string | null;
  period: ReportPeriod;
}): Promise<ReportRows> {
  const { customerId, zoneSlug, period } = opts;
  const z = schema.zones;
  const d = schema.devices;
  const zoneFilter = and(eq(z.customerId, customerId), zoneSlug ? eq(z.slug, zoneSlug) : undefined);

  const [zones, deviceRows] = await Promise.all([
    db.select({ slug: z.slug, name: z.name }).from(z).where(zoneFilter).orderBy(asc(z.name)),
    db
      .select({
        mac: d.deviceId,
        name: d.name,
        zoneSlug: z.slug,
        zoneName: z.name,
        reportIntervalS: d.reportIntervalS,
      })
      .from(d)
      .innerJoin(z, eq(d.zoneId, z.id))
      .where(zoneFilter)
      .orderBy(asc(z.name), asc(d.name), asc(d.deviceId)),
  ]);

  if (deviceRows.length === 0) return { zones, devices: [], faults: [], energy: [] };

  const macs = deviceRows.map((r) => r.mac);
  const [firstReports, faults, energy] = await Promise.all([
    loadFirstReports(macs),
    loadFaults(macs, period),
    loadEnergy(
      deviceRows.map((r) => ({ mac: r.mac, capS: Math.round(freshMs(r) / 1000) })),
      period,
    ),
  ]);
  const devices: ReportDeviceRow[] = deviceRows.map((r) => ({
    mac: r.mac,
    name: r.name,
    zoneSlug: r.zoneSlug,
    zoneName: r.zoneName,
    firstReportAt: firstReports.get(r.mac) ?? null,
  }));
  return { zones, devices, faults, energy };
}

/**
 * Cihazın bilinen İLK D4i raporu — ölçüm kaydının başladığı an. Rapor bu
 * tarihten önceki günleri "veri yok" sayar (sıfır değil): sistem ya da cihaz
 * dönemin ortasında devreye girdiyse toplamlar ayın tamamı sanılmasın.
 * Cihaz başına `(device_id, recorded_at)` index'inden tek satır okunur.
 */
async function loadFirstReports(macs: string[]): Promise<Map<string, Date>> {
  const t = schema.d4iTelemetry;
  const list = sql.join(
    macs.map((m) => sql`(${m}::varchar)`),
    sql`, `,
  );
  const result = await db.execute<{ mac: string; first_at: string | Date | null }>(sql`
    SELECT m.mac,
           (SELECT ${t.recordedAt} FROM ${t}
             WHERE ${t.deviceId} = m.mac AND ${t.recordedAt} IS NOT NULL
             ORDER BY ${t.recordedAt} ASC LIMIT 1) AS first_at
    FROM (VALUES ${list}) AS m(mac)
  `);
  const out = new Map<string, Date>();
  for (const r of result.rows) {
    if (r.first_at) out.set(r.mac, new Date(r.first_at));
  }
  return out;
}

/** Dönemle kesişen arıza kayıtları (dönemden önce başlayıp süren dahil). */
async function loadFaults(macs: string[], period: ReportPeriod): Promise<ReportFaultRow[]> {
  const f = schema.faultEvents;
  return db
    .select({
      mac: f.deviceId,
      channel: f.channel,
      code: f.code,
      detail: f.detail,
      startedAt: f.startedAt,
      resolvedAt: f.resolvedAt,
    })
    .from(f)
    .where(
      and(
        inArray(f.deviceId, macs),
        lt(f.startedAt, period.end),
        or(isNull(f.resolvedAt), gt(f.resolvedAt, period.start)),
      ),
    )
    .orderBy(asc(f.startedAt));
}

type EnergySqlRow = {
  mac: string;
  day: string | null;
  is_total: number;
  wh: number;
  pairs: number;
  on_s: number;
  lamps: number;
  samples: number;
};

/**
 * Enerji ve yaklaşık yanma süresi — tek sorgu, sonuç küçük (cihaz × gün).
 *
 * `energy_wh` armatür başına BİRİKİMLİ sayaçtır. Armatür başına ardışık iki
 * okumanın farkı (LAG), sonraki okumanın Türkiye gününe yazılır:
 *  - fark < 0 → sayaç sıfırlandı (sürücü değişti), 0 sayılır;
 *  - fark > geçen saat × MAX_LAMP_W → sıçrama, sayılmaz;
 *  - NULL (sayaç yok / maskeli) → atlanır.
 * Dönem başındaki ilk fark kaybolmasın diye LOOKBACK_MS kadar önceki okuma da
 * okunur ama yalnızca dönem içindeki okumaların farkı toplanır.
 *
 * Yanma süresi: önceki okumada seviye > 0 ise aradaki süre eklenir; her aralık
 * cihazın ölçüm penceresiyle (`freshMs`) sınırlanır — susmuş cihazın son
 * durumu günlerce "yanıyor" sayılmasın.
 *
 * GROUPING SETS: (cihaz, gün) satırları + `day` NULL olan cihaz toplamı (dönem
 * boyunca ölçüm gönderen farklı armatür sayısı bu satırdadır).
 */
async function loadEnergy(
  devices: Array<{ mac: string; capS: number }>,
  period: ReportPeriod,
): Promise<ReportEnergyRow[]> {
  const t = schema.d4iTelemetry;
  const lookback = new Date(period.start.getTime() - LOOKBACK_MS);
  const caps = sql.join(
    devices.map((x) => sql`(${x.mac}::varchar, ${x.capS}::float8)`),
    sql`, `,
  );
  const macs = devices.map((x) => x.mac);

  const result = await db.execute<EnergySqlRow>(sql`
    WITH cap(mac, cap_s) AS (VALUES ${caps}),
    s AS (
      SELECT ${t.deviceId} AS mac, ${t.channel} AS ch, ${t.recordedAt} AS ts,
             ${t.energyWh} AS e, ${t.actualLevel} AS lvl,
             LAG(${t.energyWh}) OVER w AS prev_e,
             LAG(${t.recordedAt}) OVER w AS prev_ts,
             LAG(${t.actualLevel}) OVER w AS prev_lvl
      FROM ${t}
      WHERE ${inArray(t.deviceId, macs)}
        AND ${gte(t.recordedAt, lookback)}
        AND ${lt(t.recordedAt, period.end)}
      WINDOW w AS (PARTITION BY ${t.deviceId}, ${t.channel} ORDER BY ${t.recordedAt})
    ),
    d AS (
      SELECT s.*,
             EXTRACT(EPOCH FROM (s.ts - s.prev_ts))::float8 AS dt,
             to_char(s.ts AT TIME ZONE ${REPORT_TZ}::text, 'YYYY-MM-DD') AS day
      FROM s
      WHERE s.ts >= ${period.start.toISOString()}::timestamptz
    )
    SELECT d.mac,
           d.day,
           GROUPING(d.day)::int AS is_total,
           COALESCE(SUM(d.e - d.prev_e) FILTER (
             WHERE d.e >= d.prev_e AND d.dt > 0 AND d.e - d.prev_e <= d.dt / 3600.0 * ${MAX_LAMP_W}
           ), 0)::float8 AS wh,
           COUNT(*) FILTER (WHERE d.e IS NOT NULL AND d.prev_e IS NOT NULL)::int AS pairs,
           COALESCE(SUM(LEAST(d.dt, cap.cap_s)) FILTER (WHERE d.prev_lvl > 0 AND d.dt > 0), 0)::float8 AS on_s,
           COUNT(DISTINCT d.ch)::int AS lamps,
           COUNT(*)::int AS samples
    FROM d
    JOIN cap ON cap.mac = d.mac
    GROUP BY GROUPING SETS ((d.mac, d.day), (d.mac))
  `);

  return result.rows.map((r) => ({
    mac: r.mac,
    day: Number(r.is_total) === 1 ? null : r.day,
    wh: Number(r.wh),
    pairs: Number(r.pairs),
    onS: Number(r.on_s),
    lamps: Number(r.lamps),
    samples: Number(r.samples),
  }));
}
