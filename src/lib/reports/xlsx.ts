import "server-only";
import ExcelJS from "exceljs";
import { formatMac } from "@/lib/mac";
import { localParts } from "@/lib/scheduleTime";
import { isoDateToDisplay } from "@/lib/dateFormat";
import type { ReportData, ReportEvent, ReportFaultKind } from "@/types/report";

/**
 * Raporun Excel çıktısı. Sayfalar: Özet, Cihazlar, Arıza türleri, Arıza
 * kayıtları, Günlük (+ tüm bölgeler seçiliyse Bölgeler).
 *
 * Excel saat dilimi tutmaz: tarihler Türkiye saatindeki "duvar saati" olarak
 * yazılır (UTC alanlarına yerel saat konur), böylece hücrede görünen saat
 * paneldekiyle aynıdır. Sayı biçimleri nokta ile yazılır; Excel kullanıcının
 * yerel ayarına göre virgülle gösterir.
 */

const HOUR_MS = 3_600_000;
const FMT_DATETIME = "dd/mm/yyyy hh:mm";
const FMT_DATE = "dd/mm/yyyy";
const FMT_KWH = "#,##0.00";
const FMT_HOURS = "#,##0.0";
const FMT_INT = "#,##0";

/** Türkiye saatindeki duvar saati (dakika hassasiyetinde), Excel tarihi olarak. */
function trWall(iso: string): Date {
  const p = localParts(new Date(iso));
  return new Date(Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes));
}

function dayDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const hours = (ms: number) => ms / HOUR_MS;

function kindText(kind: ReportFaultKind, technical: boolean): string {
  if (kind === "fault") return "Arıza";
  if (kind === "warning") return "Uyarı";
  return technical ? "Komut hatası" : "Uygulanamayan komut";
}

interface Column {
  header: string;
  key: string;
  width: number;
  numFmt?: string;
}

/** Başlık satırı kalın + gri, üst satır dondurulmuş, otomatik süzgeç açık. */
function addTable(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Column[],
  rows: Array<Record<string, unknown>>,
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
    style: c.numFmt ? { numFmt: c.numFmt } : {},
  }));
  ws.addRows(rows);
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 30;
  head.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEBE6" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFB5B0A6" } } };
  });
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return ws;
}

export async function reportWorkbook(report: ReportData, events: ReportEvent[]): Promise<Uint8Array> {
  const { technical, totals, period } = report;
  const codeHeader = technical ? "MAC" : "Cihaz kodu";
  const lampHeader = technical ? "Kanal" : "Armatür no";
  const commandHeader = technical ? "Komut hatası" : "Uygulanamayan komut";

  const wb = new ExcelJS.Workbook();
  wb.creator = "Fener";
  wb.created = new Date();

  // ── Özet ──
  const summary = wb.addWorksheet("Özet");
  summary.columns = [
    { key: "k", width: 38 },
    { key: "v", width: 44 },
  ];
  const title = summary.addRow([`Rapor · ${report.customer.name}`]);
  title.font = { bold: true, size: 14 };
  summary.addRow([]);
  const info: Array<[string, unknown, string?]> = [
    ["Bölge", report.zone?.name ?? "Tüm bölgeler"],
    [
      "Dönem",
      `${isoDateToDisplay(period.from)} – ${isoDateToDisplay(period.to)}${period.partial ? " (bugün dahil, rapor anına kadar)" : ""}`,
    ],
    ["Gün sayısı", period.days, FMT_INT],
    ["Oluşturulma", trWall(report.generatedAt), FMT_DATETIME],
    ["Ölçüm kaydı başlangıcı", report.coverage.dataFrom ? trWall(report.coverage.dataFrom) : "Bu dönemde ölçüm yok", FMT_DATETIME],
    ["Kayıt öncesi gün (veri yok)", report.coverage.uncoveredDays, FMT_INT],
    ["Ölçümü dönem içinde başlayan cihaz", report.coverage.partialDevices, FMT_INT],
    ["", ""],
    ["Toplam enerji (kWh)", totals.energyKwh ?? "Ölçüm yok", FMT_KWH],
    ["Günlük ortalama enerji (kWh)", totals.avgDailyKwh ?? "—", FMT_KWH],
    ["Ölçüm alınan cihaz", `${totals.measuredDevices} / ${totals.devices}`],
    ["", ""],
    ["Arıza sayısı (dönemde başlayan)", totals.faults, FMT_INT],
    ["Arıza yaşayan cihaz", totals.faultyDevices, FMT_INT],
    ["Dönem sonunda süren arıza", totals.openAtEnd, FMT_INT],
    ["Toplam arızalı kalma süresi (saat)", hours(totals.faultDurationMs), FMT_HOURS],
    ["En sık arıza", totals.topFault ? `${totals.topFault.label} (${totals.topFault.count})` : "—"],
    ["Uyarı sayısı", totals.warnings, FMT_INT],
    [commandHeader, totals.commandErrors, FMT_INT],
  ];
  for (const [k, v, fmt] of info) {
    const row = summary.addRow([k, v]);
    row.getCell(1).font = { color: { argb: "FF58554F" } };
    const cell = row.getCell(2);
    cell.alignment = { horizontal: "left" };
    if (fmt && typeof v !== "string") cell.numFmt = fmt;
  }
  summary.addRow([]);
  const notes = [
    "Veri silinmez; ancak ölçüm kaydı başlamadan önceki günler sıfır değil \"veri yok\" sayılır. Günlük ortalama yalnızca kayıtlı günlere bölünür.",
    "Enerji, armatür sayaçlarındaki artıştan hesaplanır; ölçüm göndermeyen cihazlar toplama girmez.",
    "Yanma süresi raporlardaki ışık seviyesinden çıkarılan yaklaşık değerdir (armatür başına ortalama).",
    "Arızalı kalma süresinde aynı anda süren arızalar bir kez sayılır. Uyarılar (ısınma, güç sınırlama) arıza sayısına girmez.",
    "Cihazlar bugünkü bölgelerinde gösterilir.",
  ];
  for (const n of notes) {
    const row = summary.addRow([n]);
    row.font = { italic: true, color: { argb: "FF75716A" } };
    summary.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.height = 30;
  }

  // ── Cihazlar ──
  addTable(
    wb,
    "Cihazlar",
    [
      { header: "Cihaz", key: "name", width: 26 },
      { header: codeHeader, key: "mac", width: 20 },
      { header: "Bölge", key: "zone", width: 22 },
      { header: "Arıza sayısı", key: "faults", width: 12, numFmt: FMT_INT },
      { header: "En sık arıza", key: "top", width: 34 },
      { header: "Arızalı kalma süresi (saat)", key: "faultH", width: 16, numFmt: FMT_HOURS },
      { header: "Dönem sonunda süren arıza", key: "open", width: 14, numFmt: FMT_INT },
      { header: "Uyarı", key: "warnings", width: 10, numFmt: FMT_INT },
      { header: commandHeader, key: "commands", width: 14, numFmt: FMT_INT },
      { header: "Enerji (kWh)", key: "kwh", width: 14, numFmt: FMT_KWH },
      { header: "Yanma süresi (saat, armatür başına)", key: "burn", width: 18, numFmt: FMT_HOURS },
      { header: "Ölçüm", key: "measured", width: 10 },
      { header: "Ölçüm başlangıcı", key: "dataFrom", width: 17, numFmt: FMT_DATETIME },
      { header: "Dönemi tam kapsıyor", key: "full", width: 12 },
    ],
    report.devices.map((d) => ({
      name: d.name,
      mac: formatMac(d.mac),
      zone: d.zoneName,
      faults: d.faults,
      top: d.topFault ? `${d.topFault.label} (${d.topFault.count})` : "",
      faultH: hours(d.faultDurationMs),
      open: d.openAtEnd,
      warnings: d.warnings,
      commands: d.commandErrors,
      kwh: d.energyKwh,
      burn: d.burnHours,
      measured: d.measured ? "Var" : "Yok",
      dataFrom: d.dataFrom ? trWall(d.dataFrom) : null,
      full: !d.measured ? "Hayır" : d.partial ? "Hayır" : "Evet",
    })),
  );

  // ── Arıza türleri ──
  const typeColumns: Column[] = [
    { header: "Arıza", key: "label", width: 40 },
    { header: "Bölüm", key: "category", width: 18 },
    { header: "Tür", key: "kind", width: 18 },
    { header: "Adet (dönemde başlayan)", key: "count", width: 14, numFmt: FMT_INT },
    { header: "Etkilenen cihaz", key: "devices", width: 12, numFmt: FMT_INT },
    { header: "Etkilenen armatür", key: "lamps", width: 12, numFmt: FMT_INT },
    { header: "Toplam süre (saat)", key: "hours", width: 14, numFmt: FMT_HOURS },
    { header: "Dönem sonunda süren", key: "open", width: 12, numFmt: FMT_INT },
  ];
  if (technical) typeColumns.push({ header: "Kod", key: "code", width: 30 });
  addTable(
    wb,
    "Arıza türleri",
    typeColumns,
    report.faultTypes.map((t) => ({
      label: t.label,
      category: t.category,
      kind: kindText(t.kind, technical),
      count: t.count,
      devices: t.devices,
      lamps: t.kind === "command" ? null : t.lamps,
      hours: hours(t.durationMs),
      open: t.openAtEnd,
      code: t.code,
    })),
  );

  // ── Arıza kayıtları ──
  const eventColumns: Column[] = [
    { header: "Başlangıç", key: "start", width: 17, numFmt: FMT_DATETIME },
    { header: "Bitiş", key: "end", width: 17, numFmt: FMT_DATETIME },
    { header: "Süre (saat)", key: "hours", width: 11, numFmt: FMT_HOURS },
    { header: "Cihaz", key: "device", width: 26 },
    { header: codeHeader, key: "mac", width: 20 },
    { header: "Bölge", key: "zone", width: 22 },
    { header: lampHeader, key: "channel", width: 11 },
    { header: "Arıza", key: "label", width: 40 },
    { header: "Bölüm", key: "category", width: 18 },
    { header: "Tür", key: "kind", width: 18 },
  ];
  if (technical) {
    eventColumns.push({ header: "Kod", key: "code", width: 30 }, { header: "Ayrıntı", key: "detail", width: 40 });
  }
  addTable(
    wb,
    "Arıza kayıtları",
    eventColumns,
    events.map((e) => ({
      start: trWall(e.startedAt),
      end: e.resolvedAt ? trWall(e.resolvedAt) : "Sürüyor",
      hours: hours(e.durationMs),
      device: e.deviceName,
      mac: formatMac(e.mac),
      zone: e.zoneName,
      channel: e.channel,
      label: e.label,
      category: e.category,
      kind: kindText(e.kind, technical),
      code: e.code,
      detail: e.detail,
    })),
  );

  // ── Günlük ──
  addTable(
    wb,
    "Günlük",
    [
      { header: "Tarih", key: "date", width: 13, numFmt: FMT_DATE },
      { header: "Enerji (kWh)", key: "kwh", width: 14, numFmt: FMT_KWH },
      { header: "Yeni arıza", key: "faults", width: 12, numFmt: FMT_INT },
      { header: "Yeni uyarı", key: "warnings", width: 12, numFmt: FMT_INT },
      { header: "Veri", key: "covered", width: 16 },
    ],
    report.daily.map((d) => ({
      date: dayDate(d.date),
      kwh: d.energyKwh,
      // Kayıt öncesi günde sayılar boş kalır (0 yazmak "arıza yok" gibi okunur).
      faults: d.covered || d.faults > 0 ? d.faults : null,
      warnings: d.covered || d.warnings > 0 ? d.warnings : null,
      covered: d.covered ? "Var" : "Kayıt öncesi",
    })),
  );

  // ── Bölgeler ──
  if (report.zones.length > 0) {
    addTable(
      wb,
      "Bölgeler",
      [
        { header: "Bölge", key: "name", width: 26 },
        { header: "Cihaz", key: "devices", width: 10, numFmt: FMT_INT },
        { header: "Ölçüm alınan cihaz", key: "measured", width: 14, numFmt: FMT_INT },
        { header: "Arıza sayısı", key: "faults", width: 12, numFmt: FMT_INT },
        { header: "Arıza yaşayan cihaz", key: "faulty", width: 14, numFmt: FMT_INT },
        { header: "Dönem sonunda süren arıza", key: "open", width: 14, numFmt: FMT_INT },
        { header: "Enerji (kWh)", key: "kwh", width: 14, numFmt: FMT_KWH },
      ],
      report.zones.map((z) => ({
        name: z.name,
        devices: z.devices,
        measured: z.measuredDevices,
        faults: z.faults,
        faulty: z.faultyDevices,
        open: z.openAtEnd,
        kwh: z.energyKwh,
      })),
    );
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

/** `rapor-<müşteri>-<bölge|tum>-<başlangıç>_<bitiş>.xlsx` (slug'lar ASCII). */
export function reportFileName(report: ReportData): string {
  return `rapor-${report.customer.slug}-${report.zone?.slug ?? "tum"}-${report.period.from}_${report.period.to}.xlsx`;
}
