"use client";

import { useEffect, useState } from "react";
import type { ReportData, ReportDay, ReportDevice, ReportFaultKind } from "@/types/report";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, useTechnical } from "@/app/_lib/panel";
import { formatDuration } from "@/app/_lib/format";
import { formatMac } from "@/lib/mac";
import { formatDate, isoDateToDisplay } from "@/lib/dateFormat";
import {
  REPORT_MAX_DAYS,
  REPORT_TZ,
  parseReportRange,
  rangeErrorText,
  reportPresets,
  type ReportPresetKey,
} from "@/lib/reports/range";
import { useDialogs } from "../PanelDialogs";
import { DateField } from "../DateField";
import { EmptyBox, PageHeader, Pager, StatCard, pageSlice } from "../PanelUi";

const PAGE_SIZE = 20;

const trKwh = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const trKwh2 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trInt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const trHours = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Büyük değerde ondalık gereksiz: 1.248 kWh; küçükte 3,4 kWh. */
const kwhText = (v: number) => (v >= 100 ? trInt.format(v) : trKwh.format(v));
const durationText = (ms: number) => (ms > 0 ? formatDuration(ms) : "—");
/** "18/11" — grafik ekseni için kısa gün. */
const shortDay = (iso: string) => isoDateToDisplay(iso).slice(0, 5);

function kindLabel(kind: ReportFaultKind, technical: boolean): string {
  if (kind === "warning") return "Uyarı";
  if (kind === "command") return technical ? "Komut hatası" : "Uygulanamayan komut";
  return "Arıza";
}

// Hazır dönem çipi (Efektler/zamanlama çipleriyle aynı görünüm).
const chip = (active: boolean) =>
  `inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full px-3.5 text-[13px] transition-colors duration-150 ${
    active
      ? "border border-text bg-text font-medium text-bg hover:bg-text/85"
      : "border border-border bg-panel text-ink-2 hover:border-glow/50 hover:bg-glow/10 hover:text-text"
  }`;

/**
 * Günlük çubuk grafik — tek seri, başlık seriyi adlandırır (lejant yok).
 * Çubuğun üzerine gelince / odaklanınca gün ve değer üstte yazılır.
 * Değeri olmayan gün (ölçüm yok) çubuksuz, ince taban çizgisiyle görünür.
 */
function DailyBars({
  days,
  value,
  format,
  unit,
  barClass,
  label,
  emptyText,
}: {
  days: ReportDay[];
  value: (d: ReportDay) => number | null;
  format: (v: number) => string;
  unit: string;
  barClass: string;
  label: string;
  emptyText: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map(value);
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const total = values.reduce<number>((s, v) => s + (v ?? 0), 0);
  const shown = hover !== null ? days[hover] : null;
  // Ölçüm kaydı öncesi gün: sıfır değil "veri yok" — gri bantla gösterilir.
  const noRecord = (i: number) => !days[i].covered && values[i] === null;
  const anyNoRecord = days.some((_, i) => noRecord(i));
  const dayText = (i: number) => {
    const v = values[i];
    if (v !== null) return `${format(v)} ${unit}`;
    return noRecord(i) ? "ölçüm kaydı öncesi, veri yok" : "veri yok";
  };
  const tickIdx = days.length > 1 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : [0];

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-[14px] border border-border bg-panel px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-text">{label}</h2>
        <p className="text-[12.5px] tabular-nums text-muted" aria-live="polite">
          {shown
            ? `${isoDateToDisplay(shown.date)} · ${dayText(hover!)}`
            : max > 0
              ? `en yüksek ${format(max)} ${unit}`
              : ""}
        </p>
      </div>
      {max === 0 && total === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{emptyText}</p>
      ) : (
        <div>
          <div className="relative h-[140px] border-b border-border-strong">
            {/* Yalnızca orta kılavuz çizgisi; eksen sakin kalsın. */}
            <div aria-hidden className="absolute inset-x-0 top-1/2 border-t border-dashed border-border" />
            <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-label={label}>
              {days.map((d, i) => {
                const v = values[i];
                const h = v && max > 0 ? Math.max(2, (v / max) * 100) : 0;
                return (
                  <button
                    key={d.date}
                    type="button"
                    role="listitem"
                    aria-label={`${isoDateToDisplay(d.date)}: ${dayText(i)}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="group flex h-full min-w-0 flex-1 items-end focus-visible:outline-none"
                  >
                    {noRecord(i) ? (
                      <span
                        className={`block h-full w-full rounded-t-[4px] bg-panel-2 ${
                          hover === i ? "bg-track" : ""
                        } group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-accent`}
                      />
                    ) : (
                      <span
                        className={`block w-full rounded-t-[4px] transition-opacity ${barClass} ${
                          hover !== null && hover !== i ? "opacity-45" : ""
                        } group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-accent`}
                        style={{ height: `${h}%` }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="relative mt-1.5 h-4 text-[11px] tabular-nums text-muted">
            {tickIdx.map((i, k) => (
              <span
                key={i}
                className="absolute"
                style={
                  k === 0
                    ? { left: 0 }
                    : k === tickIdx.length - 1
                      ? { right: 0 }
                      : { left: `${((i + 0.5) / days.length) * 100}%`, transform: "translateX(-50%)" }
                }
              >
                {shortDay(days[i].date)}
              </span>
            ))}
          </div>
          {anyNoRecord ? (
            <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-muted">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px] bg-panel-2 ring-1 ring-border" />
              Ölçüm kaydı öncesi (veri yok)
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Gün sayısı yazımı: "1 gün", "14 gün". */
const daysText = (n: number) => `${n} gün`;

/**
 * Veri kapsaması uyarısı. Veri silinmez ama ölçüm kaydı dönemin ortasında
 * başlamış olabilir (sistem ya da cihaz sonradan devreye girdi): o kısım sıfır
 * değil "veri yok"tur ve toplamlar dönemin tamamı sanılmamalı.
 */
function CoverageNote({ report }: { report: ReportData }) {
  const c = report.coverage;
  const lines: string[] = [];
  if (c.dataFrom && c.uncoveredDays > 0) {
    lines.push(
      `Ölçüm kaydı ${formatDate(c.dataFrom, REPORT_TZ)} tarihinde başlıyor. Dönemin ilk ${daysText(c.uncoveredDays)} için veri yok; toplamlar ve ortalamalar yalnızca kayıtlı günleri kapsar.`,
    );
  }
  if (c.partialDevices > 0) {
    lines.push(
      `${c.partialDevices} cihazın ölçümü dönem içinde başladı; bu cihazların değerleri dönemin tamamını kapsamaz.`,
    );
  }
  if (c.noDataDevices > 0) {
    lines.push(`${c.noDataDevices} cihazdan bu dönemde hiç ölçüm alınmadı.`);
  }
  if (lines.length === 0) return null;
  return (
    <div role="note" className="flex gap-3 rounded-[12px] border border-glow/40 bg-accent-soft px-4 py-3 text-[13px] text-text">
      <span aria-hidden className="mt-px font-semibold text-accent">
        ⓘ
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Veri kapsaması</p>
        {lines.map((l) => (
          <p key={l} className="text-ink-2">
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Dönemde hiç ölçüm kaydı yoksa sayıların yerine bu gösterilir (0 arıza / 0 kWh yanıltır). */
function NoRecordBox({ report }: { report: ReportData }) {
  const later = report.devices
    .map((d) => d.dataFrom)
    .filter((x): x is string => x !== null)
    .sort()[0];
  return (
    <EmptyBox>
      <p className="font-semibold text-text">Bu dönem için ölçüm kaydı yok</p>
      <p className="mt-1">
        Seçilen tarihlerde bu cihazlardan rapor alınmamış; arıza ve enerji bilgisi gösterilemez.
        {later ? ` İlk ölçüm ${formatDate(later, REPORT_TZ)} tarihinde alındı.` : ""}
      </p>
    </EmptyBox>
  );
}

type SortKey = "faults" | "duration" | "energy" | "burn" | "name";

const SORTS: Record<SortKey, (a: ReportDevice, b: ReportDevice) => number> = {
  faults: (a, b) => b.faults - a.faults || b.faultDurationMs - a.faultDurationMs,
  duration: (a, b) => b.faultDurationMs - a.faultDurationMs || b.faults - a.faults,
  energy: (a, b) => (b.energyKwh ?? -1) - (a.energyKwh ?? -1),
  burn: (a, b) => (b.burnHours ?? -1) - (a.burnHours ?? -1),
  name: (a, b) => a.name.localeCompare(b.name, "tr"),
};

/** Sıralanabilir sütun başlığı (sayılar azalan, ad artan). */
function SortTh({
  k,
  sort,
  onSort,
  num = true,
  children,
}: {
  k: SortKey;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  num?: boolean;
  children: React.ReactNode;
}) {
  const active = sort === k;
  return (
    <th
      className={`px-3 py-3 font-semibold first:pl-[22px] last:pr-[22px] ${num ? "text-right" : "text-left"}`}
      aria-sort={active ? (k === "name" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 [letter-spacing:inherit] [text-transform:inherit] hover:text-text ${active ? "text-text" : ""}`}
      >
        {children}
        <span aria-hidden className={active ? "text-accent" : "opacity-0"}>
          {k === "name" ? "↑" : "↓"}
        </span>
      </button>
    </th>
  );
}

/**
 * Raporlar: seçilen dönemde (en fazla 90 gün) arıza sıklığı ve türleri,
 * arızalı kalma süresi, enerji ve yaklaşık yanma süresi; Excel'e aktarma.
 * Hesap sunucuda (`GET /api/reports`, lib/reports/build.ts).
 */
export function ReportsView() {
  const api = useApi();
  const technical = useTechnical();
  const { zones, devices: liveDevices } = useLighting();
  const { openDevice } = useDialogs();

  const [presets] = useState(() => reportPresets());
  const [preset, setPreset] = useState<ReportPresetKey | null>("30d");
  const initial = presets.find((p) => p.key === "30d")!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [zone, setZone] = useState("");

  const range = parseReportRange(from, to);
  const rangeError = range.ok ? null : rangeErrorText(range.error);
  const query = range.ok
    ? `/api/reports?from=${from}&to=${to}${zone ? `&zone=${encodeURIComponent(zone)}` : ""}`
    : null;

  const [report, setReport] = useState<ReportData | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("faults");
  const [page, setPage] = useState(0);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    fetch(api(query))
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !j?.ok) {
          setError(j?.error ?? "Rapor oluşturulamadı.");
          setLoadedQuery(query);
          return;
        }
        setReport(j.data as ReportData);
        setError(null);
        setLoadedQuery(query);
        setPage(0);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Rapor oluşturulamadı. Bağlantıyı kontrol edip tekrar deneyin.");
        setLoadedQuery(query);
      });
    return () => {
      cancelled = true;
    };
  }, [api, query]);

  const loading = query !== null && loadedQuery !== query;

  function pickPreset(key: ReportPresetKey) {
    const p = presets.find((x) => x.key === key)!;
    setPreset(key);
    setFrom(p.from);
    setTo(p.to);
  }

  function sortBy(k: SortKey) {
    setSort(k);
    setPage(0);
  }

  const sorted = report ? [...report.devices].sort(SORTS[sort]) : [];
  const { page: shownPage, rows } = pageSlice(sorted, page, PAGE_SIZE);
  const t = report?.totals;
  const maxTypeCount = Math.max(1, ...(report?.faultTypes.map((x) => x.count) ?? [0]));

  const th = "px-3 py-3 text-left font-semibold first:pl-[22px] last:pr-[22px]";
  const thNum = "px-3 py-3 text-right font-semibold first:pl-[22px] last:pr-[22px]";
  const td = "px-3 py-3 align-middle first:pl-[22px] last:pr-[22px]";
  const tdNum = `${td} text-right tabular-nums`;

  return (
    <div className="flex max-w-[1200px] flex-col gap-6">
      <PageHeader
        title="Raporlar"
        subtitle={`Seçtiğiniz dönemde (en fazla ${REPORT_MAX_DAYS} gün) arızalar ve enerji kullanımı.`}
        actions={
          query && !rangeError ? (
            <a href={api(`${query}&format=xlsx`)} download className="btn-line h-9 px-3.5 text-[13.5px]">
              Excel&apos;e aktar
            </a>
          ) : null
        }
      />

      {/* Dönem ve bölge — tek satır süzgeç */}
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-panel px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset === p.key}
              onClick={() => pickPreset(p.key)}
              className={chip(preset === p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12.5px] text-muted">
            Başlangıç
            <DateField
              value={from}
              onChange={(v) => {
                setFrom(v);
                setPreset(null);
              }}
              className="!h-9 !w-36 !text-[13.5px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] text-muted">
            Bitiş
            <DateField
              value={to}
              onChange={(v) => {
                setTo(v);
                setPreset(null);
              }}
              className="!h-9 !w-36 !text-[13.5px]"
            />
          </label>
          {zones.length > 1 ? (
            <label className="flex flex-col gap-1 text-[12.5px] text-muted">
              Bölge
              <select
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                className="field !h-9 !w-auto !py-0 !text-[13.5px]"
              >
                <option value="">Tüm bölgeler</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {loading ? <span className="pb-2 text-[12.5px] text-muted">Hazırlanıyor…</span> : null}
        </div>
        {rangeError ? (
          <p role="alert" className="text-[13px] text-danger">
            {rangeError}
          </p>
        ) : null}
      </div>

      {error && !loading ? (
        <p role="alert" className="rounded-[10px] bg-danger-soft px-4 py-3 text-[13.5px] text-danger">
          {error}
        </p>
      ) : null}

      {!report ? (
        !error ? <EmptyBox>Rapor hazırlanıyor…</EmptyBox> : null
      ) : report.totals.devices === 0 ? (
        <EmptyBox>Bu kapsamda kayıtlı cihaz yok.</EmptyBox>
      ) : report.coverage.dataFrom === null ? (
        <NoRecordBox report={report} />
      ) : (
        <div className={`flex flex-col gap-6 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <p className="-mb-2 text-[13px] text-muted">
            {isoDateToDisplay(report.period.from)} – {isoDateToDisplay(report.period.to)}
            {report.period.partial ? " (bugün dahil)" : ""} · {report.zone?.name ?? "Tüm bölgeler"} ·{" "}
            {report.totals.devices} cihaz
          </p>

          <CoverageNote report={report} />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Toplam enerji"
              value={t!.energyKwh === null ? "—" : kwhText(t!.energyKwh)}
              unit={t!.energyKwh === null ? undefined : "kWh"}
              hint={
                t!.avgDailyKwh === null
                  ? "Dönemde ölçüm alınamadı"
                  : `Günde ortalama ${kwhText(t!.avgDailyKwh)} kWh · ${t!.measuredDevices}/${t!.devices} cihazdan ölçüm`
              }
            />
            <StatCard
              label="Arıza sayısı"
              value={trInt.format(t!.faults)}
              valueClass={t!.faults > 0 ? "text-danger" : "text-text"}
              hint={
                t!.warnings > 0 || t!.commandErrors > 0
                  ? `+ ${t!.warnings} uyarı · ${t!.commandErrors} ${technical ? "komut hatası" : "uygulanamayan komut"}`
                  : "Dönemde başlayan arızalar"
              }
            />
            <StatCard
              label="Arıza yaşayan cihaz"
              value={trInt.format(t!.faultyDevices)}
              unit={`/ ${t!.devices}`}
              hint={
                t!.faultDurationMs > 0
                  ? `Toplam arızalı kalma: ${formatDuration(t!.faultDurationMs)}`
                  : "Dönemde arızalı kalan cihaz yok"
              }
            />
            <StatCard
              label="En sık arıza"
              value={t!.topFault ? `${t!.topFault.count}×` : "—"}
              hint={t!.topFault ? t!.topFault.label : "Dönemde arıza başlamadı"}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <DailyBars
              days={report.daily}
              value={(d) => d.energyKwh}
              format={(v) => (v >= 100 ? trInt.format(v) : trKwh.format(v))}
              unit="kWh"
              barClass="bg-glow"
              label="Günlük enerji"
              emptyText="Dönemde enerji ölçümü yok."
            />
            <DailyBars
              days={report.daily}
              value={(d) => (d.covered || d.faults > 0 ? d.faults : null)}
              format={(v) => trInt.format(v)}
              unit="arıza"
              barClass="bg-ink-2"
              label="Günlük yeni arıza"
              emptyText="Dönemde yeni arıza başlamadı."
            />
          </div>

          {/* Arıza türleri */}
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Arıza türleri · {report.faultTypes.length}</h2>
            {report.faultTypes.length === 0 ? (
              <EmptyBox>Dönemde arıza, uyarı ya da {technical ? "komut hatası" : "uygulanamayan komut"} yok.</EmptyBox>
            ) : (
              <div className="overflow-x-auto rounded-[14px] border border-border bg-panel">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead className="table-head">
                    <tr>
                      <th className={th}>Sorun</th>
                      <th className={thNum}>Adet</th>
                      <th className={thNum}>Cihaz</th>
                      <th className={thNum}>Toplam süre</th>
                      <th className={thNum}>Süren</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.faultTypes.map((ft) => (
                      <tr key={ft.code} className="border-t border-border">
                        <td className={td}>
                          <div className="flex flex-col gap-1.5">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-text">{ft.label}</span>
                              {ft.kind !== "command" ? <span className="text-[12px] text-muted">{ft.category}</span> : null}
                              {ft.kind !== "fault" ? (
                                <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                                  {kindLabel(ft.kind, technical)}
                                </span>
                              ) : null}
                            </span>
                            {/* Adedin en sık türe oranı */}
                            <span aria-hidden className="block h-1.5 w-full max-w-[280px] rounded-full bg-track">
                              <span
                                className={`block h-full rounded-full ${ft.kind === "fault" ? "bg-ink-2" : "bg-border-strong"}`}
                                style={{ width: `${(ft.count / maxTypeCount) * 100}%` }}
                              />
                            </span>
                            {technical ? <span className="font-mono text-[11.5px] text-muted">{ft.code}</span> : null}
                          </div>
                        </td>
                        <td className={`${tdNum} font-semibold text-text`}>{trInt.format(ft.count)}</td>
                        <td className={`${tdNum} text-ink-2`}>{trInt.format(ft.devices)}</td>
                        <td className={`${tdNum} text-ink-2`}>{durationText(ft.durationMs)}</td>
                        <td className={`${tdNum} ${ft.openAtEnd > 0 ? "font-semibold text-danger" : "text-muted"}`}>
                          {ft.openAtEnd > 0 ? trInt.format(ft.openAtEnd) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Cihazlar */}
          <section className="flex flex-col gap-3">
            <h2 className="eyebrow">Cihazlar · {report.devices.length}</h2>
            <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-sm">
                  <thead className="table-head">
                    <tr>
                      <SortTh k="name" sort={sort} onSort={sortBy} num={false}>
                        Cihaz
                      </SortTh>
                      {report.zone ? null : <th className={th}>Bölge</th>}
                      <SortTh k="faults" sort={sort} onSort={sortBy}>Arıza</SortTh>
                      <th className={th}>En sık arıza</th>
                      <SortTh k="duration" sort={sort} onSort={sortBy}>Arızalı kalma</SortTh>
                      <SortTh k="energy" sort={sort} onSort={sortBy}>Enerji</SortTh>
                      <SortTh k="burn" sort={sort} onSort={sortBy}>Yanma süresi</SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => {
                      const live = liveDevices.find((x) => x.deviceId === d.mac);
                      return (
                        <tr
                          key={d.mac}
                          onClick={live ? () => openDevice(live) : undefined}
                          className={`border-t border-border transition-colors ${live ? "cursor-pointer hover:bg-panel-2/60" : ""}`}
                        >
                          <td className={td}>
                            <div className="flex flex-col">
                              {live ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDevice(live);
                                  }}
                                  className="text-left font-medium text-text hover:text-accent"
                                >
                                  {d.name}
                                </button>
                              ) : (
                                <span className="font-medium text-text">{d.name}</span>
                              )}
                              <span className="font-mono text-[11.5px] text-muted">{formatMac(d.mac)}</span>
                            </div>
                          </td>
                          {report.zone ? null : <td className={`${td} text-ink-2`}>{d.zoneName}</td>}
                          <td className={`${tdNum} ${d.faults > 0 ? "font-semibold text-text" : "text-muted"}`}>
                            {d.faults > 0 ? trInt.format(d.faults) : "—"}
                            {d.openAtEnd > 0 ? (
                              <span className="ml-1.5 rounded-md bg-danger-soft px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                                süren {d.openAtEnd}
                              </span>
                            ) : null}
                          </td>
                          <td className={`${td} text-ink-2`}>
                            {d.topFault ? (
                              <>
                                {d.topFault.label}
                                <span className="ml-1 text-muted">({d.topFault.count})</span>
                              </>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className={`${tdNum} text-ink-2`}>{durationText(d.faultDurationMs)}</td>
                          <td className={`${tdNum} text-ink-2`}>
                            {d.energyKwh !== null ? (
                              `${trKwh2.format(d.energyKwh)} kWh`
                            ) : (
                              <span className="text-muted">{d.measured ? "—" : "Veri yok"}</span>
                            )}
                            {d.partial && d.measured && d.dataFrom ? (
                              <span className="block text-[11.5px] text-muted">
                                {formatDate(d.dataFrom, REPORT_TZ)} tarihinden itibaren
                              </span>
                            ) : null}
                          </td>
                          <td className={`${tdNum} text-ink-2`}>
                            {d.burnHours !== null ? `${trHours.format(d.burnHours)} sa` : <span className="text-muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={shownPage} pageSize={PAGE_SIZE} total={sorted.length} onPage={setPage} label="Cihaz sayfaları" />
            </div>
          </section>

          {/* Bölgeler (tüm bölgeler seçiliyken) */}
          {report.zones.length > 1 ? (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">Bölgeler · {report.zones.length}</h2>
              <div className="overflow-x-auto rounded-[14px] border border-border bg-panel">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead className="table-head">
                    <tr>
                      <th className={th}>Bölge</th>
                      <th className={thNum}>Cihaz</th>
                      <th className={thNum}>Arıza</th>
                      <th className={thNum}>Arıza yaşayan cihaz</th>
                      <th className={thNum}>Enerji</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.zones.map((z) => (
                      <tr
                        key={z.slug}
                        onClick={() => setZone(z.slug)}
                        className="cursor-pointer border-t border-border transition-colors hover:bg-panel-2/60"
                      >
                        <td className={`${td} font-medium text-text`}>{z.name}</td>
                        <td className={`${tdNum} text-ink-2`}>{trInt.format(z.devices)}</td>
                        <td className={`${tdNum} ${z.faults > 0 ? "font-semibold text-text" : "text-muted"}`}>
                          {z.faults > 0 ? trInt.format(z.faults) : "—"}
                        </td>
                        <td className={`${tdNum} text-ink-2`}>{trInt.format(z.faultyDevices)}</td>
                        <td className={`${tdNum} text-ink-2`}>
                          {z.energyKwh !== null ? `${kwhText(z.energyKwh)} kWh` : <span className="text-muted">Veri yok</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-muted">
            <li>Enerji, armatür sayaçlarındaki artıştan hesaplanır; ölçüm göndermeyen cihazlar toplama girmez.</li>
            <li>Yanma süresi, raporlardaki ışık seviyesinden çıkarılan yaklaşık değerdir (armatür başına ortalama).</li>
            <li>
              Arıza sayısı dönemde başlayan arızalardır. Uyarılar (aşırı ısınma nedeniyle güç azaltma, güç
              sınırlaması) arıza sayısına girmez. Arızalı kalma süresinde aynı anda süren arızalar bir kez sayılır.
            </li>
            <li>Cihazlar bugünkü bölgelerinde gösterilir.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
