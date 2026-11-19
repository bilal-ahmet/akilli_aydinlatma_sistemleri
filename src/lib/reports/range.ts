/**
 * Rapor dönemi (saf; sunucu ve istemci birlikte kullanır).
 *
 * Dönem Türkiye takvim günleriyle verilir: `from` günü 00:00'dan `to` gününün
 * ertesi 00:00'a kadar. Bugünü kapsıyorsa bitiş "şimdi"dir (`partial`).
 * En fazla 31 gün; gelecek gün seçilemez.
 */
import { localDateString, localToUtc, SCHEDULE_TZ } from "@/lib/scheduleTime";

export const REPORT_MAX_DAYS = 31;
/** Gün anahtarlarının ve gün sınırlarının saat dilimi. */
export const REPORT_TZ = SCHEDULE_TZ;

const DAY_MS = 86_400_000;

export interface ReportPeriod {
  from: string;
  to: string;
  days: number;
  start: Date;
  end: Date;
  partial: boolean;
}

export type RangeError = "format" | "order" | "too_long" | "future";

export type RangeResult = { ok: true; period: ReportPeriod } | { ok: false; error: RangeError };

type Ymd = [number, number, number];

function parseYmd(s: string | null | undefined): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-31 gibi taşan tarihleri reddet.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return [y, mo, d];
}

const ymdMs = ([y, m, d]: Ymd) => Date.UTC(y, m - 1, d);

function fmtYmd(ms: number): string {
  const dt = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** YYYY-MM-DD'ye gün ekler (takvim hesabı, saat diliminden bağımsız). */
export function addDaysIso(iso: string, n: number): string {
  const p = parseYmd(iso);
  if (!p) throw new Error(`Geçersiz tarih: ${iso}`);
  return fmtYmd(ymdMs(p) + n * DAY_MS);
}

/** `from`…`to` arasındaki bütün günler (dahil). */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/** Türkiye takvim gününün başladığı an. */
export function dayStart(iso: string): Date {
  const p = parseYmd(iso);
  if (!p) throw new Error(`Geçersiz tarih: ${iso}`);
  return localToUtc(p[0], p[1], p[2], 0);
}

export function parseReportRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date = new Date(),
): RangeResult {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return { ok: false, error: "format" };
  const days = (ymdMs(b) - ymdMs(a)) / DAY_MS + 1;
  if (days < 1) return { ok: false, error: "order" };
  if (days > REPORT_MAX_DAYS) return { ok: false, error: "too_long" };
  const today = localDateString(now);
  if (to! > today) return { ok: false, error: "future" };

  const start = dayStart(from!);
  const nextDay = dayStart(addDaysIso(to!, 1));
  const partial = nextDay.getTime() > now.getTime();
  return {
    ok: true,
    period: { from: from!, to: to!, days, start, end: partial ? now : nextDay, partial },
  };
}

export function rangeErrorText(error: RangeError): string {
  switch (error) {
    case "format":
      return "Başlangıç ve bitiş tarihini gg/aa/yyyy biçiminde girin.";
    case "order":
      return "Bitiş tarihi başlangıç tarihinden önce olamaz.";
    case "too_long":
      return `Rapor dönemi en fazla ${REPORT_MAX_DAYS} gün olabilir.`;
    case "future":
      return "Bitiş tarihi bugünden sonra olamaz.";
  }
}

export type ReportPresetKey = "7d" | "30d" | "month" | "prev_month";

export interface ReportPreset {
  key: ReportPresetKey;
  label: string;
  from: string;
  to: string;
}

/** Hazır dönemler; hepsi `REPORT_MAX_DAYS` içinde kalır. */
export function reportPresets(now: Date = new Date()): ReportPreset[] {
  const today = localDateString(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevEnd = addDaysIso(monthStart, -1);
  const prevStart = `${prevEnd.slice(0, 7)}-01`;
  return [
    { key: "7d", label: "Son 7 gün", from: addDaysIso(today, -6), to: today },
    { key: "30d", label: "Son 30 gün", from: addDaysIso(today, -29), to: today },
    { key: "month", label: "Bu ay", from: monthStart, to: today },
    { key: "prev_month", label: "Geçen ay", from: prevStart, to: prevEnd },
  ];
}
