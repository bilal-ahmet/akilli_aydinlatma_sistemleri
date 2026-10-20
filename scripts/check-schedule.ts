/**
 * Zamanlama zaman hesabının (lib/sun.ts, lib/scheduleTime.ts) saf kontrolü.
 * Sunucu/DB gerekmez:  npm run check:schedule
 *
 * Türkiye 2016'dan beri kışın da UTC+3: Aralık'ta gün batımı ~17:36 (eski
 * UTC+2 tablolarındaki 16:3x değil).
 * Gün batımı referansları İzmit için (±4 dk tolerans; algoritma ±1-2 dk).
 */
import { sunEventUtc } from "../src/lib/sun";
import {
  EVERY_DAY,
  WEEKDAYS_ONLY,
  describeSchedule,
  formatClock,
  localParts,
  localToUtc,
  nextRunAt,
  type ScheduleSpec,
} from "../src/lib/scheduleTime";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const local = (d: Date | null) => (d ? formatClock(localParts(d).minutes) : "null");
const minutesOf = (d: Date | null) => (d ? localParts(d).minutes : NaN);
const near = (d: Date | null, hhmm: string, tol = 4) => {
  const [h, m] = hhmm.split(":").map(Number);
  return Math.abs(minutesOf(d) - (h * 60 + m)) <= tol;
};

// Gün batımı / doğumu (İzmit, Türkiye saati)
const jun = sunEventUtc(2026, 6, 21, "sunset");
check("21 Haziran gün batımı ≈ 20:34", near(jun, "20:34"), local(jun));
const dec = sunEventUtc(2026, 12, 21, "sunset");
check("21 Aralık gün batımı ≈ 17:36", near(dec, "17:36"), local(dec));
const junRise = sunEventUtc(2026, 6, 21, "sunrise");
check("21 Haziran gün doğumu ≈ 05:28", near(junRise, "05:28"), local(junRise));
const decRise = sunEventUtc(2026, 12, 21, "sunrise");
check("21 Aralık gün doğumu ≈ 08:20", near(decRise, "08:20"), local(decRise));

// Saat dilimi
const t = localToUtc(2026, 10, 20, 18 * 60 + 30);
check("18:30 TR = 15:30 UTC", t.toISOString() === "2026-10-20T15:30:00.000Z", t.toISOString());

// Haftalık sabit saat
const daily: ScheduleSpec = { repeat: "weekly", weekdays: EVERY_DAY, timeKind: "fixed", timeMinutes: 18 * 60 + 30 };
const before = localToUtc(2026, 10, 20, 17 * 60); // Salı 17:00
check("her gün: saatten önce → bugün", nextRunAt(daily, before)?.toISOString() === "2026-10-20T15:30:00.000Z");
const after = localToUtc(2026, 10, 20, 19 * 60);
check("her gün: saat geçti → yarın", nextRunAt(daily, after)?.toISOString() === "2026-10-21T15:30:00.000Z");
const exact = localToUtc(2026, 10, 20, 18 * 60 + 30);
check("her gün: tam saatte → yarın (aynı an tekrar çalışmaz)", nextRunAt(daily, exact)?.toISOString() === "2026-10-21T15:30:00.000Z");

const weekdays: ScheduleSpec = { ...daily, weekdays: WEEKDAYS_ONLY };
const friLate = localToUtc(2026, 10, 23, 20 * 60); // Cuma 20:00
check("hafta içi: Cuma akşamı → Pazartesi", nextRunAt(weekdays, friLate)?.toISOString() === "2026-10-26T15:30:00.000Z");
check("gün seçilmemiş → null", nextRunAt({ ...daily, weekdays: 0 }, before) === null);

// Gece yarısına yakın
const late: ScheduleSpec = { ...daily, timeMinutes: 23 * 60 + 59 };
check("23:59 → bugün", nextRunAt(late, localToUtc(2026, 10, 20, 23 * 60 + 58))?.toISOString() === "2026-10-20T20:59:00.000Z");
const early: ScheduleSpec = { ...daily, timeMinutes: 0 };
check("00:00 → ertesi gün", nextRunAt(early, localToUtc(2026, 10, 20, 23 * 60 + 58))?.toISOString() === "2026-10-20T21:00:00.000Z");

// Gün batımı + fark
const sunset: ScheduleSpec = { repeat: "weekly", weekdays: EVERY_DAY, timeKind: "sunset", offsetMinutes: 10 };
const sunNext = nextRunAt(sunset, localToUtc(2026, 6, 21, 12 * 60));
check("gün batımından 10 dk sonra ≈ 20:44", near(sunNext, "20:44"), local(sunNext));
check("dakikaya yuvarlanır", (sunNext?.getUTCSeconds() ?? 1) === 0);

// Tek sefer
const once: ScheduleSpec = { repeat: "once", runDate: "2026-10-21", timeKind: "fixed", timeMinutes: 6 * 60 };
check("tek sefer: gelecekte", nextRunAt(once, before)?.toISOString() === "2026-10-21T03:00:00.000Z");
check("tek sefer: geçmişte → null", nextRunAt(once, localToUtc(2026, 10, 22, 0)) === null);
check("tek sefer: bozuk tarih → null", nextRunAt({ ...once, runDate: "21.10.2026" }, before) === null);

// Metinler
check("metin: her gün", describeSchedule(daily) === "Her gün · 18:30", describeSchedule(daily));
check("metin: gün batımı", describeSchedule(sunset) === "Her gün · Gün batımından 10 dk sonra", describeSchedule(sunset));
check(
  "metin: gün doğumu önce",
  describeSchedule({ ...sunset, timeKind: "sunrise", offsetMinutes: -15, weekdays: WEEKDAYS_ONLY }) ===
    "Hafta içi · Gün doğumundan 15 dk önce",
);
check("metin: tek sefer", describeSchedule(once) === "21 Ekim 2026 · 06:00", describeSchedule(once));

console.log(failures ? `\n${failures} kontrol başarısız` : "\nHepsi geçti");
process.exit(failures ? 1 : 0);
