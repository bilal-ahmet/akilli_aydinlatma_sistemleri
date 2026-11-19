/**
 * Rapor hesabının (lib/reports/range.ts, lib/reports/build.ts) saf kontrolü.
 * Sunucu/DB gerekmez:  npm run check:reports
 *
 * Enerji farkı SQL'de hesaplanır (lib/reports/query.ts); burada yalnızca
 * toplanması sınanır. SQL'in kendisi yerel DB'ye karşı uçtan uca denenir.
 */
import {
  addDaysIso,
  dayStart,
  eachDay,
  parseReportRange,
  reportPresets,
  type ReportPeriod,
} from "../src/lib/reports/range";
import { buildEvents, buildReport, clip, unionMs, type ReportInput } from "../src/lib/reports/build";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const H = 3_600_000;
// 19/11/2026 15:00 Türkiye (UTC+3)
const now = new Date("2026-11-19T12:00:00Z");

// ── Dönem ───────────────────────────────────────────────────
const r31 = parseReportRange("2026-10-01", "2026-10-31", now);
check("31 gün kabul", r31.ok && r31.period.days === 31);
check("32 gün reddedilir", !parseReportRange("2026-10-01", "2026-11-01", now).ok);
const rev = parseReportRange("2026-10-10", "2026-10-09", now);
check("ters aralık reddedilir", !rev.ok && rev.error === "order");
const fut = parseReportRange("2026-11-19", "2026-11-20", now);
check("gelecek gün reddedilir", !fut.ok && fut.error === "future");
check("taşan tarih reddedilir", !parseReportRange("2026-02-29", "2026-03-01", now).ok);
check("bozuk biçim reddedilir", !parseReportRange("19/11/2026", "2026-11-19", now).ok);
check("tek gün kabul", parseReportRange("2026-11-01", "2026-11-01", now).ok);

if (r31.ok) {
  check("başlangıç TR gece yarısı", r31.period.start.toISOString() === "2026-09-30T21:00:00.000Z", r31.period.start.toISOString());
  check("bitiş ertesi gün 00:00", r31.period.end.toISOString() === "2026-10-31T21:00:00.000Z", r31.period.end.toISOString());
  check("geçmiş dönem kesilmez", !r31.period.partial);
}
const today = parseReportRange("2026-11-01", "2026-11-19", now);
check("bugünü kapsayan dönem şimdi'de biter", today.ok && today.period.partial && today.period.end.getTime() === now.getTime());

check("ay geçişi", addDaysIso("2026-10-31", 1) === "2026-11-01");
check("yıl geçişi", addDaysIso("2026-01-01", -1) === "2025-12-31");
check("eachDay sayısı", eachDay("2026-02-25", "2026-03-02").length === 6);
check("dayStart", dayStart("2026-11-19").toISOString() === "2026-11-18T21:00:00.000Z");

const presets = Object.fromEntries(reportPresets(now).map((p) => [p.key, p]));
check("Son 7 gün", presets["7d"].from === "2026-11-13" && presets["7d"].to === "2026-11-19");
check("Son 30 gün", presets["30d"].from === "2026-10-21" && presets["30d"].to === "2026-11-19");
check("Bu ay", presets.month.from === "2026-11-01" && presets.month.to === "2026-11-19");
check("Geçen ay", presets.prev_month.from === "2026-10-01" && presets.prev_month.to === "2026-10-31");
const march = Object.fromEntries(reportPresets(new Date("2026-03-05T10:00:00Z")).map((p) => [p.key, p]));
check("Geçen ay (Şubat)", march.prev_month.from === "2026-02-01" && march.prev_month.to === "2026-02-28");
for (const p of reportPresets(now)) {
  check(`hazır dönem geçerli: ${p.label}`, parseReportRange(p.from, p.to, now).ok);
}

// ── Aralık yardımcıları ─────────────────────────────────────
check("clip içeride", JSON.stringify(clip(5, 8, 0, 10)) === "[5,8]");
check("clip taşan", JSON.stringify(clip(-5, 20, 0, 10)) === "[0,10]");
check("clip dışarıda null", clip(11, 20, 0, 10) === null);
check("union çakışan bir kez", unionMs([[0, 10], [5, 15], [20, 25]]) === 20);
check("union iç içe", unionMs([[0, 10], [2, 3]]) === 10);
check("union boş", unionMs([]) === 0);

// ── Rapor ───────────────────────────────────────────────────
const period = (parseReportRange("2026-10-01", "2026-10-31", now) as { ok: true; period: ReportPeriod }).period;
const at = (iso: string) => new Date(iso);
const input: ReportInput = {
  period,
  customer: { slug: "test", name: "Test" },
  zone: null,
  technical: false,
  now,
  zones: [
    { slug: "a", name: "A Bölgesi" },
    { slug: "b", name: "B Bölgesi" },
  ],
  devices: [
    { mac: "AAAAAAAAAAA1", name: "Direk 1", zoneSlug: "a", zoneName: "A Bölgesi" },
    { mac: "AAAAAAAAAAA2", name: null, zoneSlug: "a", zoneName: "A Bölgesi" },
    { mac: "BBBBBBBBBBB1", name: "Direk 3", zoneSlug: "b", zoneName: "B Bölgesi" },
  ],
  faults: [
    // Dönemden önce başladı, içinde bitti: sayılmaz, süresi 1 Ekim 00:00'dan (TR) itibaren.
    { mac: "AAAAAAAAAAA1", channel: 0, code: "lamp_failure", detail: null, startedAt: at("2026-09-30T18:00:00Z"), resolvedAt: at("2026-09-30T23:00:00Z") },
    // Aynı cihaz, iki kod aynı anda (birleşimde bir kez).
    { mac: "AAAAAAAAAAA1", channel: 0, code: "lamp_failure", detail: null, startedAt: at("2026-10-05T00:00:00Z"), resolvedAt: at("2026-10-05T04:00:00Z") },
    { mac: "AAAAAAAAAAA1", channel: 1, code: "led.open_circuit", detail: null, startedAt: at("2026-10-05T02:00:00Z"), resolvedAt: at("2026-10-05T06:00:00Z") },
    { mac: "AAAAAAAAAAA1", channel: 1, code: "lamp_failure", detail: null, startedAt: at("2026-10-10T00:00:00Z"), resolvedAt: at("2026-10-10T01:00:00Z") },
    // Uyarı: arıza sayısına girmez.
    { mac: "AAAAAAAAAAA2", channel: 0, code: "driver.thermal_derating", detail: null, startedAt: at("2026-10-06T00:00:00Z"), resolvedAt: at("2026-10-06T01:00:00Z") },
    // Komut hatası (channel null).
    { mac: "AAAAAAAAAAA2", channel: null, code: "command.unknown-action", detail: "bilinmeyen action", startedAt: at("2026-10-07T00:00:00Z"), resolvedAt: at("2026-10-07T00:10:00Z") },
    // Dönem sonunda süren (hâlâ açık).
    { mac: "BBBBBBBBBBB1", channel: 2, code: "led.open_circuit", detail: null, startedAt: at("2026-10-30T21:00:00Z"), resolvedAt: null },
  ],
  energy: [
    { mac: "AAAAAAAAAAA1", day: null, wh: 12_000, pairs: 100, onS: 2 * 36_000, lamps: 2, samples: 120 },
    { mac: "AAAAAAAAAAA1", day: "2026-10-01", wh: 5_000, pairs: 50, onS: 36_000, lamps: 2, samples: 60 },
    { mac: "AAAAAAAAAAA1", day: "2026-10-02", wh: 7_000, pairs: 50, onS: 36_000, lamps: 2, samples: 60 },
    // Ölçüm var ama sayaç farkı yok (enerji bilinmiyor).
    { mac: "AAAAAAAAAAA2", day: null, wh: 0, pairs: 0, onS: 3_600, lamps: 1, samples: 10 },
    { mac: "AAAAAAAAAAA2", day: "2026-10-01", wh: 0, pairs: 0, onS: 3_600, lamps: 1, samples: 10 },
    // BBBBBBBBBBB1 hiç ölçüm göndermedi.
  ],
};

const rep = buildReport(input);
const dev = Object.fromEntries(rep.devices.map((d) => [d.mac, d]));

check("toplam arıza (uyarı/komut hariç, dönemde başlayan)", rep.totals.faults === 4, String(rep.totals.faults));
check("uyarı ayrı sayılır", rep.totals.warnings === 1);
check("komut hatası ayrı sayılır", rep.totals.commandErrors === 1);
check("cihaz 1 arıza sayısı", dev.AAAAAAAAAAA1.faults === 3, String(dev.AAAAAAAAAAA1.faults));
check(
  "cihaz 1 arızalı süre: 2 sa (dönem başı) + 6 sa (birleşim) + 1 sa",
  dev.AAAAAAAAAAA1.faultDurationMs === 9 * H,
  String(dev.AAAAAAAAAAA1.faultDurationMs / H),
);
check("cihaz 1 en sık arıza lamba arızası", dev.AAAAAAAAAAA1.topFault?.code === "lamp_failure" && dev.AAAAAAAAAAA1.topFault.count === 2);
check("cihaz 1 sade başlık", dev.AAAAAAAAAAA1.topFault?.label === "Armatür arızası");
check("cihaz 2 arıza yok (yalnızca uyarı)", dev.AAAAAAAAAAA2.faults === 0 && dev.AAAAAAAAAAA2.faultDurationMs === 0);
check("cihaz 2 sade adı", dev.AAAAAAAAAAA2.name === "Cihaz …AAA2", dev.AAAAAAAAAAA2.name);
check("süren arıza", dev.BBBBBBBBBBB1.openAtEnd === 1 && rep.totals.openAtEnd === 1);
check(
  "süren arızanın süresi dönem sonunda kesilir (24 sa)",
  dev.BBBBBBBBBBB1.faultDurationMs === 24 * H,
  String(dev.BBBBBBBBBBB1.faultDurationMs / H),
);
check("arıza yaşayan cihaz", rep.totals.faultyDevices === 2);

check("enerji kWh", dev.AAAAAAAAAAA1.energyKwh === 12);
check("sayaç farkı yoksa enerji null", dev.AAAAAAAAAAA2.energyKwh === null && dev.AAAAAAAAAAA2.measured);
check("ölçümsüz cihaz", dev.BBBBBBBBBBB1.energyKwh === null && !dev.BBBBBBBBBBB1.measured);
check("yanma süresi armatür başına ortalama (10 sa)", dev.AAAAAAAAAAA1.burnHours === 10);
check("toplam enerji", rep.totals.energyKwh === 12);
check("ölçüm alınan cihaz", rep.totals.measuredDevices === 2);
check("günlük ortalama (31 gün)", Math.abs((rep.totals.avgDailyKwh ?? 0) - 12 / 31) < 1e-9);

check("günlük seri 31 gün", rep.daily.length === 31);
const d1 = rep.daily.find((d) => d.date === "2026-10-01")!;
const d3 = rep.daily.find((d) => d.date === "2026-10-03")!;
check("günlük enerji", d1.energyKwh === 5 && rep.daily.find((d) => d.date === "2026-10-02")!.energyKwh === 7);
check("ölçümsüz gün null", d3.energyKwh === null);
check("arıza TR gününe yazılır (05 Ekim 03:00)", rep.daily.find((d) => d.date === "2026-10-05")!.faults === 2);
check("31 Ekim 00:00 TR başlayan arıza 31 Ekim'e", rep.daily.find((d) => d.date === "2026-10-31")!.faults === 1);

const top = rep.totals.topFault;
// lamba arızası ve açık devre 2-2 eşit; eşitlikte toplam süresi uzun olan (açık devre 28 sa > 7 sa).
check("en sık arıza: eşitlikte süre", top?.code === "led.open_circuit" && top.count === 2, JSON.stringify(top));
const types = Object.fromEntries(rep.faultTypes.map((t) => [t.code, t]));
check("tür: lamba arızası 2 cihazda değil 1'de", types.lamp_failure.devices === 1 && types.lamp_failure.lamps === 2);
check("tür: uyarı etiketli", types["driver.thermal_derating"].kind === "warning");
check("tür: komut başlığı katalogdan", types["command.unknown-action"].kind === "command" && types["command.unknown-action"].label.length > 0);
check("türler adede göre sıralı", rep.faultTypes[0].count >= rep.faultTypes[rep.faultTypes.length - 1].count);

check("bölge kırılımı", rep.zones.length === 2 && rep.zones[0].faults === 3 && rep.zones[1].faults === 1);
check("bölge enerjisi", rep.zones[0].energyKwh === 12 && rep.zones[1].energyKwh === null);

const zoned = buildReport({ ...input, zone: { slug: "a", name: "A Bölgesi" } });
check("tek bölgede bölge kırılımı yok", zoned.zones.length === 0);

const events = buildEvents(input);
check("kayıtlar: dönemle kesişenler (7)", events.length === 7, String(events.length));
check("kayıtlar eskiden yeniye", events[0].startedAt < events[events.length - 1].startedAt);
check("müşteride ham ayrıntı yok", events.every((e) => e.detail === null));
const techEvents = buildEvents({ ...input, technical: true });
check("admin'de ham ayrıntı var", techEvents.some((e) => e.detail === "bilinmeyen action"));
const outside = buildReport({
  ...input,
  faults: [{ mac: "AAAAAAAAAAA1", channel: 0, code: "lamp_failure", detail: null, startedAt: at("2026-09-01T00:00:00Z"), resolvedAt: at("2026-09-02T00:00:00Z") }],
});
check("dönem dışı kayıt yok sayılır", outside.faultTypes.length === 0 && outside.totals.faults === 0);

console.log(failures === 0 ? "\nTüm kontroller geçti." : `\n${failures} kontrol başarısız.`);
process.exit(failures === 0 ? 0 : 1);
