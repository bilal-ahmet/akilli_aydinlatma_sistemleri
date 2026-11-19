/**
 * Rapor hesabı (saf): sorgu satırlarından `ReportData` üretir. DB'ye dokunmaz;
 * `npm run check:reports` bu dosyayı doğrudan sınar.
 *
 * Kurallar (CLAUDE.md "Raporlar"):
 * - Arıza = armatür kaydı (`channel` dolu) ve uyarı değil. Uyarı =
 *   `isWarningCode`. Komut hatası = `channel` boş (`command.*`).
 * - Sayı = dönemde BAŞLAYAN kayıt. Süre = kaydın dönemle kesişimi; cihazın
 *   arızalı kalma süresinde aynı anda süren arızalar bir kez sayılır (birleşim).
 * - Enerji sayaç farkından SQL'de hesaplanır (bkz. query.ts); burada toplanır.
 */
import { faultCategory, faultCategoryLabel, faultLabel, isWarningCode } from "@/lib/faults";
import { describeDeviceError } from "@/lib/deviceErrors";
import { deviceName } from "@/app/_lib/format";
import { localDateString } from "@/lib/scheduleTime";
import { dayStart, eachDay, type ReportPeriod } from "./range";
import type {
  ReportCoverage,
  ReportData,
  ReportDay,
  ReportDevice,
  ReportEvent,
  ReportFaultKind,
  ReportFaultType,
  ReportTopFault,
  ReportZone,
} from "@/types/report";

export interface ReportDeviceRow {
  mac: string;
  name: string | null;
  zoneSlug: string;
  zoneName: string;
  /** Cihazın bilinen ilk D4i raporu; hiç yoksa null. */
  firstReportAt: Date | null;
}

export interface ReportZoneRow {
  slug: string;
  name: string;
}

export interface ReportFaultRow {
  mac: string;
  channel: number | null;
  code: string;
  detail: string | null;
  startedAt: Date;
  resolvedAt: Date | null;
}

/** Enerji/yanma toplamı: `day` dolu → o günün satırı, null → cihazın dönem toplamı. */
export interface ReportEnergyRow {
  mac: string;
  day: string | null;
  wh: number;
  /** Geçerli sayaç çifti sayısı (0 → enerji bilinmiyor). */
  pairs: number;
  /** Yaklaşık yanma süresi, armatürlerin toplamı (sn). */
  onS: number;
  /** Ölçüm gönderen farklı armatür. */
  lamps: number;
  /** Dönemdeki rapor sayısı. */
  samples: number;
}

export interface ReportInput {
  period: ReportPeriod;
  customer: { slug: string; name: string };
  zone: { slug: string; name: string } | null;
  technical: boolean;
  now: Date;
  zones: ReportZoneRow[];
  devices: ReportDeviceRow[];
  faults: ReportFaultRow[];
  energy: ReportEnergyRow[];
}

// ── Aralık yardımcıları ───────────────────────────────────────

type Span = [number, number];

/** Kayıt aralığının [start, end) ile kesişimi; kesişmiyorsa null. */
export function clip(startMs: number, endMs: number, from: number, to: number): Span | null {
  const s = Math.max(startMs, from);
  const e = Math.min(endMs, to);
  return e > s ? [s, e] : null;
}

/** Aralıkların birleşiminin toplam uzunluğu (çakışan kısım bir kez). */
export function unionMs(spans: Span[]): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce) {
      if (e > ce) ce = e;
    } else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  return total + (ce - cs);
}

// ── Sınıflama ve başlıklar ────────────────────────────────────

export function faultKindOf(row: Pick<ReportFaultRow, "channel" | "code">): ReportFaultKind {
  if (row.channel === null || row.code.startsWith("command")) return "command";
  return isWarningCode(row.code) ? "warning" : "fault";
}

/** Kodun başlığı; komut hatasında ham metin katalogdan okunur. */
function labelOf(code: string, detail: string | null, technical: boolean): string {
  if (code.startsWith("command") && detail) return describeDeviceError(detail, { technical }).title;
  return faultLabel(code, technical);
}

function categoryOf(code: string, technical: boolean): string {
  return faultCategoryLabel(faultCategory(code), technical);
}

/** En sık kod; eşitlikte toplam süresi uzun olan, o da eşitse alfabetik. */
function pickTop(counts: Map<string, { count: number; durationMs: number; label: string }>): ReportTopFault | null {
  let best: { code: string; count: number; durationMs: number; label: string } | null = null;
  for (const [code, v] of counts) {
    if (v.count === 0) continue;
    if (
      !best ||
      v.count > best.count ||
      (v.count === best.count && v.durationMs > best.durationMs) ||
      (v.count === best.count && v.durationMs === best.durationMs && code < best.code)
    ) {
      best = { code, ...v };
    }
  }
  return best ? { code: best.code, label: best.label, count: best.count } : null;
}

// ── Ana hesap ─────────────────────────────────────────────────

interface Classified extends ReportFaultRow {
  kind: ReportFaultKind;
  label: string;
  /** Dönemde başladı mı (sayılır). */
  startedIn: boolean;
  /** Dönemle kesişim. */
  span: Span | null;
  /** Dönem sonunda sürüyor mu. */
  openAtEnd: boolean;
}

function classify(input: ReportInput): Classified[] {
  const from = input.period.start.getTime();
  const to = input.period.end.getTime();
  const now = input.now.getTime();
  const out: Classified[] = [];
  for (const f of input.faults) {
    const s = f.startedAt.getTime();
    const e = f.resolvedAt ? f.resolvedAt.getTime() : now;
    const span = clip(s, e, from, to);
    const startedIn = s >= from && s < to;
    if (!span && !startedIn) continue;
    out.push({
      ...f,
      kind: faultKindOf(f),
      label: labelOf(f.code, f.detail, input.technical),
      startedIn,
      span,
      openAtEnd: s < to && (f.resolvedAt === null || f.resolvedAt.getTime() > to),
    });
  }
  return out;
}

const kwh = (wh: number) => wh / 1000;

export function buildReport(input: ReportInput): ReportData {
  const { period, technical } = input;
  const faults = classify(input);

  // Cihaz başına enerji ve günlük toplamlar
  const energyTotal = new Map<string, ReportEnergyRow>();
  const dailyWh = new Map<string, { wh: number; pairs: number }>();
  for (const r of input.energy) {
    if (r.day === null) {
      energyTotal.set(r.mac, r);
    } else {
      const d = dailyWh.get(r.day) ?? { wh: 0, pairs: 0 };
      d.wh += r.wh;
      d.pairs += r.pairs;
      dailyWh.set(r.day, d);
    }
  }

  const byDevice = new Map<string, Classified[]>();
  for (const f of faults) {
    const list = byDevice.get(f.mac);
    if (list) list.push(f);
    else byDevice.set(f.mac, [f]);
  }

  const devices: ReportDevice[] = input.devices.map((d) => {
    const list = byDevice.get(d.mac) ?? [];
    const lampFaults = list.filter((f) => f.kind === "fault");
    const counts = new Map<string, { count: number; durationMs: number; label: string }>();
    for (const f of lampFaults) {
      const c = counts.get(f.code) ?? { count: 0, durationMs: 0, label: f.label };
      if (f.startedIn) c.count += 1;
      if (f.span) c.durationMs += f.span[1] - f.span[0];
      counts.set(f.code, c);
    }
    const e = energyTotal.get(d.mac);
    return {
      mac: d.mac,
      name: deviceName({ name: d.name, deviceId: d.mac }, technical),
      zoneSlug: d.zoneSlug,
      zoneName: d.zoneName,
      faults: lampFaults.filter((f) => f.startedIn).length,
      warnings: list.filter((f) => f.kind === "warning" && f.startedIn).length,
      commandErrors: list.filter((f) => f.kind === "command" && f.startedIn).length,
      topFault: pickTop(counts),
      faultDurationMs: unionMs(lampFaults.flatMap((f) => (f.span ? [f.span] : []))),
      openAtEnd: lampFaults.filter((f) => f.openAtEnd).length,
      energyKwh: e && e.pairs > 0 ? kwh(e.wh) : null,
      burnHours: e && e.lamps > 0 ? e.onS / e.lamps / 3600 : null,
      lamps: e?.lamps ?? 0,
      measured: (e?.samples ?? 0) > 0,
      dataFrom: d.firstReportAt ? d.firstReportAt.toISOString() : null,
      // Ölçümü dönem içinde, ilk günden SONRA başladıysa dönemin başı için verisi yok.
      // Dönemden sonra başlayan cihaz kısmi değil, "veri yok"tur (noDataDevices).
      partial:
        d.firstReportAt !== null &&
        d.firstReportAt.getTime() < period.end.getTime() &&
        localDateString(d.firstReportAt) > period.from,
    };
  });

  // Veri kapsaması: kapsamdaki en eski ölçümden önceki günler "veri yok".
  const endMs = period.end.getTime();
  const firsts = input.devices
    .map((d) => d.firstReportAt?.getTime())
    .filter((t): t is number => t !== undefined && t < endMs);
  const dataFromMs = firsts.length > 0 ? Math.min(...firsts) : null;
  const coveredFrom = dataFromMs === null ? null : localDateString(new Date(dataFromMs));
  const isCovered = (date: string) => coveredFrom !== null && date >= coveredFrom;

  // Arıza türleri (bütün türler; uyarılar ve komut hataları etiketli)
  const types = new Map<string, ReportFaultType & { macs: Set<string>; lampKeys: Set<string> }>();
  for (const f of faults) {
    let t = types.get(f.code);
    if (!t) {
      t = {
        code: f.code,
        label: f.label,
        category: categoryOf(f.code, technical),
        kind: f.kind,
        count: 0,
        devices: 0,
        lamps: 0,
        durationMs: 0,
        openAtEnd: 0,
        macs: new Set(),
        lampKeys: new Set(),
      };
      types.set(f.code, t);
    }
    if (f.startedIn) t.count += 1;
    if (f.span) t.durationMs += f.span[1] - f.span[0];
    if (f.openAtEnd) t.openAtEnd += 1;
    t.macs.add(f.mac);
    if (f.channel !== null) t.lampKeys.add(`${f.mac}:${f.channel}`);
  }
  const faultTypes: ReportFaultType[] = [...types.values()]
    .map(({ macs, lampKeys, ...t }) => ({ ...t, devices: macs.size, lamps: lampKeys.size }))
    .sort((a, b) => b.count - a.count || b.durationMs - a.durationMs || a.label.localeCompare(b.label, "tr"));

  const allCounts = new Map<string, { count: number; durationMs: number; label: string }>();
  for (const t of faultTypes) {
    if (t.kind === "fault") allCounts.set(t.code, { count: t.count, durationMs: t.durationMs, label: t.label });
  }

  // Günlük seri
  const dayFaults = new Map<string, { faults: number; warnings: number }>();
  for (const f of faults) {
    if (!f.startedIn || f.kind === "command") continue;
    const day = localDateString(f.startedAt);
    const c = dayFaults.get(day) ?? { faults: 0, warnings: 0 };
    if (f.kind === "fault") c.faults += 1;
    else c.warnings += 1;
    dayFaults.set(day, c);
  }
  const daily: ReportDay[] = eachDay(period.from, period.to).map((date) => {
    const e = dailyWh.get(date);
    const c = dayFaults.get(date);
    return {
      date,
      energyKwh: e && e.pairs > 0 ? kwh(e.wh) : null,
      faults: c?.faults ?? 0,
      warnings: c?.warnings ?? 0,
      covered: isCovered(date),
    };
  });

  // Toplamlar
  const measuredEnergy = devices.filter((d) => d.energyKwh !== null);
  const energyKwh = measuredEnergy.length > 0 ? measuredEnergy.reduce((s, d) => s + d.energyKwh!, 0) : null;
  // Günlük ortalama yalnızca ölçüm kaydı olan kısma bölünür (kayıt öncesi günler sıfır sayılmaz).
  const avgFrom =
    coveredFrom === null ? period.start.getTime() : Math.max(period.start.getTime(), dayStart(coveredFrom).getTime());
  const elapsedDays = Math.max(1, (endMs - avgFrom) / 86_400_000);
  const coverage: ReportCoverage = {
    dataFrom: dataFromMs === null ? null : new Date(dataFromMs).toISOString(),
    uncoveredDays: daily.filter((d) => !d.covered).length,
    partialDevices: devices.filter((d) => d.partial).length,
    noDataDevices: devices.filter((d) => d.dataFrom === null || Date.parse(d.dataFrom) >= endMs).length,
  };

  const zones: ReportZone[] = input.zone
    ? []
    : input.zones.map((z) => {
        const list = devices.filter((d) => d.zoneSlug === z.slug);
        const withEnergy = list.filter((d) => d.energyKwh !== null);
        return {
          slug: z.slug,
          name: z.name,
          devices: list.length,
          measuredDevices: list.filter((d) => d.measured).length,
          faults: list.reduce((s, d) => s + d.faults, 0),
          faultyDevices: list.filter((d) => d.faultDurationMs > 0 || d.faults > 0).length,
          openAtEnd: list.reduce((s, d) => s + d.openAtEnd, 0),
          energyKwh: withEnergy.length > 0 ? withEnergy.reduce((s, d) => s + d.energyKwh!, 0) : null,
        };
      });

  return {
    period: {
      from: period.from,
      to: period.to,
      days: period.days,
      startAt: period.start.toISOString(),
      endAt: period.end.toISOString(),
      partial: period.partial,
    },
    customer: input.customer,
    zone: input.zone,
    technical,
    generatedAt: input.now.toISOString(),
    totals: {
      devices: devices.length,
      measuredDevices: devices.filter((d) => d.measured).length,
      energyKwh,
      avgDailyKwh: energyKwh === null ? null : energyKwh / elapsedDays,
      faults: devices.reduce((s, d) => s + d.faults, 0),
      warnings: devices.reduce((s, d) => s + d.warnings, 0),
      commandErrors: devices.reduce((s, d) => s + d.commandErrors, 0),
      faultyDevices: devices.filter((d) => d.faultDurationMs > 0 || d.faults > 0).length,
      openAtEnd: devices.reduce((s, d) => s + d.openAtEnd, 0),
      faultDurationMs: devices.reduce((s, d) => s + d.faultDurationMs, 0),
      topFault: pickTop(allCounts),
    },
    coverage,
    daily,
    faultTypes,
    devices,
    zones,
  };
}

/** Excel'in "Arıza kayıtları" sayfası: dönemle kesişen her kayıt, eskiden yeniye. */
export function buildEvents(input: ReportInput): ReportEvent[] {
  const { technical } = input;
  const now = input.now.getTime();
  const devices = new Map(input.devices.map((d) => [d.mac, d]));
  return classify(input)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((f) => {
      const d = devices.get(f.mac);
      return {
        startedAt: f.startedAt.toISOString(),
        resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
        mac: f.mac,
        deviceName: deviceName({ name: d?.name ?? null, deviceId: f.mac }, technical),
        zoneName: d?.zoneName ?? "",
        channel: f.channel,
        code: f.code,
        label: f.label,
        category: categoryOf(f.code, technical),
        kind: f.kind,
        detail: technical ? f.detail : null,
        durationMs: (f.resolvedAt ? f.resolvedAt.getTime() : now) - f.startedAt.getTime(),
      };
    });
}
