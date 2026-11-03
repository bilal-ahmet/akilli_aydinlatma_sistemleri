/**
 * Uygulamanın TEK tarih yazılışı: gün/ay/yıl ("03/11/2026").
 *
 * Tarih ekranda hep buradan geçer — `toLocaleDateString` ya da ay adı ("3 Kasım")
 * kullanılmaz; tarayıcı/dil ayarına göre değişen biçimler (03.11.2026, 11/3/2026)
 * karışmasın. Saf (React'siz); sunucu ve istemci birlikte kullanır.
 */

const SEP = "/";

/** Tarih giriş alanlarının ipucu metni. */
export const DATE_PLACEHOLDER = "gg/aa/yyyy";

type DateInput = Date | string | number;

const pad2 = (n: number) => String(n).padStart(2, "0");

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(key, f);
  }
  return f;
}

function partsOf(input: DateInput, timeZone?: string) {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(new Date(input))) {
    if (type !== "literal") p[type] = value;
  }
  return p;
}

/** "03/11/2026". `timeZone` verilmezse tarayıcı/sunucu saat dilimi. */
export function formatDate(input: DateInput, timeZone?: string): string {
  const p = partsOf(input, timeZone);
  return `${p.day}${SEP}${p.month}${SEP}${p.year}`;
}

/** "03/11/2026 14:35" ("seconds" ile "03/11/2026 14:35:07"). */
export function formatDateTime(
  input: DateInput,
  opts: { seconds?: boolean; timeZone?: string } = {},
): string {
  const p = partsOf(input, opts.timeZone);
  const clock = `${p.hour}:${p.minute}${opts.seconds ? `:${p.second}` : ""}`;
  return `${p.day}${SEP}${p.month}${SEP}${p.year} ${clock}`;
}

/** "YYYY-MM-DD" (API/DB biçimi) → "03/11/2026". Geçersizse boş. */
export function isoDateToDisplay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}${SEP}${m[2]}${SEP}${m[1]}` : "";
}

/**
 * Kullanıcının yazdığı "3/11/2026", "03.11.2026" ya da "03-11-2026" → "YYYY-MM-DD".
 * Takvimde olmayan gün (31/02) ve eksik giriş için null.
 */
export function displayToIsoDate(text: string): string | null {
  const m = /^\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\s*$/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * Yazarken otomatik eğik çizgi: "0311" → "03/11", "03112026" → "03/11/2026".
 * Yalnızca rakam ve ayraç kabul eder; en fazla 10 karakter.
 */
export function maskDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}${SEP}${digits.slice(2)}`;
  return `${digits.slice(0, 2)}${SEP}${digits.slice(2, 4)}${SEP}${digits.slice(4)}`;
}
