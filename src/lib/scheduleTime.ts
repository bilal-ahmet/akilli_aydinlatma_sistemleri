import { sunEventUtc } from "./sun";

/**
 * Zamanlama kontratı ve zaman hesabı (saf; istemci + sunucu ortak).
 *
 * Bütün saatler Türkiye saatidir (`SCHEDULE_TZ`), sunucunun saat diliminden
 * bağımsız. Sunucudaki zamanlayıcı `nextRunAt` ile bir sonraki anı bulur,
 * form aynı fonksiyonla "Sonraki çalışma" önizlemesini gösterir.
 */

export const SCHEDULE_TZ = "Europe/Istanbul";

export const SCHEDULE_ACTIONS = ["on", "off", "dim", "efekt", "stop_fx"] as const;
export type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

export const SCHEDULE_TIME_KINDS = ["fixed", "sunset", "sunrise"] as const;
export type ScheduleTimeKind = (typeof SCHEDULE_TIME_KINDS)[number];

export const SCHEDULE_REPEATS = ["once", "weekly"] as const;
export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

/** Gün batımı/doğumu farkı sınırı (dk). */
export const SCHEDULE_OFFSET_MAX = 180;
/** Müşteri başına en fazla zamanlama. */
export const SCHEDULE_LIMIT = 100;
/** Hedefteki en fazla öge (bölge + cihaz + lamba). */
export const SCHEDULE_TARGET_MAX = 500;
/** Sunucu kapalıyken kaçırılan çalışma bu kadar geç kalmışsa yine çalıştırılır. */
export const SCHEDULE_GRACE_MS = 15 * 60_000;

/** `planTargets` çıktısı ya da müşterinin "Tüm Sistem"i. */
export type ScheduleTarget =
  | { all: true }
  | { zones: string[]; devices: string[]; lamps: { mac: string; channel: number }[] };

export type ScheduleResult = {
  sent: number; // gönderilen komut (publish) sayısı
  skipped: number; // bulunamayan / lambası yetmeyen hedef
  missed?: boolean; // sunucu kapalıyken zamanı geçti, çalıştırılmadı
  error?: string;
};

export interface ScheduleSpec {
  repeat: ScheduleRepeat;
  runDate?: string | null; // once: YYYY-MM-DD
  weekdays?: number | null; // weekly: Pzt=1 … Paz=64
  timeKind: ScheduleTimeKind;
  timeMinutes?: number | null; // fixed: 0-1439
  offsetMinutes?: number | null; // sunset/sunrise
}

/** DB satırı / form değerleri → `ScheduleSpec` (string alanlar daraltılır). */
export function specOf(r: {
  repeat: string;
  runDate?: string | null;
  weekdays?: number | null;
  timeKind: string;
  timeMinutes?: number | null;
  offsetMinutes?: number | null;
}): ScheduleSpec {
  return {
    repeat: r.repeat as ScheduleRepeat,
    runDate: r.runDate,
    weekdays: r.weekdays,
    timeKind: r.timeKind as ScheduleTimeKind,
    timeMinutes: r.timeMinutes,
    offsetMinutes: r.offsetMinutes,
  };
}

// ── Hafta günleri ────────────────────────────────────────────
export const WEEKDAY_LABELS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;
export const EVERY_DAY = 0b1111111;
export const WEEKDAYS_ONLY = 0b0011111;
export const WEEKEND_ONLY = 0b1100000;

/** Takvim gününün hafta günü biti (Pzt=1 … Paz=64). */
export function weekdayBit(y: number, m: number, d: number): number {
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Pazar
  return 1 << ((js + 6) % 7);
}

// ── Saat dilimi ──────────────────────────────────────────────
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  minutes: number; // gece yarısından
}

export function localParts(at: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFmt.formatToParts(at)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return { y: p.year, m: p.month, d: p.day, minutes: p.hour * 60 + p.minute };
}

/** Yerel takvim günü + dakikanın UTC anı (iki geçişli ofset düzeltmesi). */
export function localToUtc(y: number, m: number, d: number, minutes: number): Date {
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const offsetAt = (ms: number) => {
    const p = localParts(new Date(ms));
    return Date.UTC(p.y, p.m - 1, p.d, 0, p.minutes) - Math.floor(ms / 60_000) * 60_000;
  };
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc);
}

function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

function parseDate(s: string | null | undefined): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Zamanlamanın verilen yerel günde çalışacağı UTC anı. */
export function occurrenceOn(spec: ScheduleSpec, y: number, m: number, d: number): Date | null {
  if (spec.timeKind === "fixed") {
    if (spec.timeMinutes == null) return null;
    return localToUtc(y, m, d, spec.timeMinutes);
  }
  const ev = sunEventUtc(y, m, d, spec.timeKind);
  if (!ev) return null;
  // Saniyeler atılır: "18:42" denince 18:42:00'de çalışsın.
  const ms = ev.getTime() + (spec.offsetMinutes ?? 0) * 60_000;
  return new Date(Math.floor(ms / 60_000) * 60_000);
}

/** `after`'dan SONRAKİ ilk çalışma anı; yoksa (geçmiş tek sefer) `null`. */
export function nextRunAt(spec: ScheduleSpec, after: Date): Date | null {
  if (spec.repeat === "once") {
    const date = parseDate(spec.runDate);
    if (!date) return null;
    const at = occurrenceOn(spec, ...date);
    return at && at.getTime() > after.getTime() ? at : null;
  }
  const mask = spec.weekdays ?? 0;
  if ((mask & EVERY_DAY) === 0) return null;
  // Dünden başlanır: gün batımından önce/sonra farkı ya da gece yarısı
  // sınırında yerel gün `after`'ın UTC gününden farklı olabilir.
  const today = localParts(after);
  for (let i = -1; i <= 8; i++) {
    const [y, m, d] = addDays(today.y, today.m, today.d, i);
    if ((weekdayBit(y, m, d) & mask) === 0) continue;
    const at = occurrenceOn(spec, y, m, d);
    if (at && at.getTime() > after.getTime()) return at;
  }
  return null;
}

// ── Metinler (müşteriye sade) ────────────────────────────────
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function describeWeekdays(mask: number): string {
  const m = mask & EVERY_DAY;
  if (m === EVERY_DAY) return "Her gün";
  if (m === WEEKDAYS_ONLY) return "Hafta içi";
  if (m === WEEKEND_ONLY) return "Hafta sonu";
  return WEEKDAY_LABELS.filter((_, i) => m & (1 << i)).join(", ");
}

export function describeTime(spec: Pick<ScheduleSpec, "timeKind" | "timeMinutes" | "offsetMinutes">): string {
  if (spec.timeKind === "fixed") return formatClock(spec.timeMinutes ?? 0);
  const name = spec.timeKind === "sunset" ? "Gün batımı" : "Gün doğumu";
  const off = spec.offsetMinutes ?? 0;
  if (off === 0) return `${name}nda`;
  return `${name}ndan ${Math.abs(off)} dk ${off < 0 ? "önce" : "sonra"}`;
}

const dateFmt = new Intl.DateTimeFormat("tr-TR", {
  timeZone: SCHEDULE_TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function describeSchedule(spec: ScheduleSpec): string {
  const when =
    spec.repeat === "once"
      ? (() => {
          const date = parseDate(spec.runDate);
          return date ? dateFmt.format(localToUtc(...date, 12 * 60)) : "Tarih yok";
        })()
      : describeWeekdays(spec.weekdays ?? 0);
  return `${when} · ${describeTime(spec)}`;
}

const weekdayFmt = new Intl.DateTimeFormat("tr-TR", { timeZone: SCHEDULE_TZ, weekday: "long" });
const shortDateFmt = new Intl.DateTimeFormat("tr-TR", {
  timeZone: SCHEDULE_TZ,
  day: "numeric",
  month: "long",
});

/** "bugün 18:42", "yarın 06:31", "Cuma 18:40", "3 Kasım 18:40". */
export function formatRunAt(at: Date, now: Date = new Date()): string {
  const a = localParts(at);
  const n = localParts(now);
  const clock = formatClock(a.minutes);
  const dayDiff = Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / 86_400_000,
  );
  if (dayDiff === 0) return `bugün ${clock}`;
  if (dayDiff === 1) return `yarın ${clock}`;
  if (dayDiff === -1) return `dün ${clock}`;
  if (dayDiff > 1 && dayDiff < 7) return `${weekdayFmt.format(at)} ${clock}`;
  return `${shortDateFmt.format(at)} ${clock}`;
}

/** Yerel bugünün tarihi (YYYY-MM-DD) — tarih alanının varsayılanı. */
export function localDateString(at: Date = new Date()): string {
  const p = localParts(at);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
