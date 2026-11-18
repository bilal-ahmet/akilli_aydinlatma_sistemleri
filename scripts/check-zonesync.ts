/**
 * Dinamik bölge aboneliğinin saf mantığı (src/lib/zoneSync/plan.ts, slug
 * yardımcıları, grup komut planı). Sunucu/DB/broker gerekmez:
 *   npm run check:zonesync
 */
import {
  applyZoneOp,
  classifyZoneResult,
  desiredZones,
  planZoneOps,
  sameZoneSet,
  type ZoneOp,
} from "../src/lib/zoneSync/plan";
import { groupSlugBase, withSuffix, fitSlug } from "../src/lib/slug";
import { isDeviceZoneSlug } from "../src/lib/binproto/command";
import { resultCodeOf } from "../src/lib/binproto/fields";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function same(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `beklenen ${e}, gelen ${a}`);
}

const DEFAULTS = ["bilisim-vadisi", "bilisim-vadisi-openthread", "ekaldes"];

// ── İstenen liste ────────────────────────────────────────────
same("istenen: bölge + gruplar, tekrarsız", desiredZones("ekaldes", ["ekaldes-hat-a", "ekaldes"]), [
  "ekaldes",
  "ekaldes-hat-a",
]);
same("istenen: kayıtsız cihaz ∅", desiredZones(undefined, undefined), []);

// ── Plan ─────────────────────────────────────────────────────
same("bilinmiyor → zone_list", planZoneOps(null, ["ekaldes"]), [{ action: "zone_list", zones: [] }]);
same("aynı küme → komut yok", planZoneOps(["b", "a"], ["a", "b"]), []);
same("varsayılan 3 → [ekaldes]: iki bölge çıkarılır", planZoneOps(DEFAULTS, ["ekaldes"]), [
  { action: "zone_remove", zones: ["bilisim-vadisi", "bilisim-vadisi-openthread"] },
]);
same("istenen ∅ → tek zone_clear", planZoneOps(DEFAULTS, []), [{ action: "zone_clear", zones: [] }]);
same("boş → ∅: komut yok", planZoneOps([], []), []);
same("4 ekleme → 3 + 1", planZoneOps([], ["a", "b", "c", "d"]), [
  { action: "zone_add", zones: ["a", "b", "c"] },
  { action: "zone_add", zones: ["d"] },
]);
same("çıkarma eklemeden önce", planZoneOps(["x"], ["y"]), [
  { action: "zone_remove", zones: ["x"] },
  { action: "zone_add", zones: ["y"] },
]);
same(
  "bölge değişimi, çok grup: clear + add daha kısa",
  planZoneOps(["old", "old-a", "old-b", "old-c", "old-d"], ["new"]),
  [
    { action: "zone_clear", zones: [] },
    { action: "zone_add", zones: ["new"] },
  ],
);

// Planı uygulayarak hedefe varılır (her adımdan sonra yeniden hesaplanır).
function converge(start: string[], desired: string[]): { end: string[]; steps: number } {
  let reported = start;
  let steps = 0;
  for (;;) {
    const op = planZoneOps(reported, desired)[0];
    if (!op || steps > 20) return { end: reported, steps };
    reported = applyZoneOp(reported, op, op.action === "zone_list" ? reported : undefined);
    steps += 1;
  }
}
const conv = converge(["a", "b", "c", "d", "e"], ["c", "f", "g", "h", "i"]);
check("adım adım istenene varılır", sameZoneSet(conv.end, ["c", "f", "g", "h", "i"]), JSON.stringify(conv));

// ── Uygulama ─────────────────────────────────────────────────
const add: ZoneOp = { action: "zone_add", zones: ["a", "b"] };
same("zone_add idempotent", applyZoneOp(["a"], add), ["a", "b"]);
same("zone_remove olmayanı yok sayar", applyZoneOp(["a"], { action: "zone_remove", zones: ["z", "a"] }), []);
same("zone_clear", applyZoneOp(["a", "b"], { action: "zone_clear", zones: [] }), []);
same("zone_list ack listesi", applyZoneOp(["x"], { action: "zone_list", zones: [] }, ["ekaldes"]), ["ekaldes"]);
same("zone_list boş ack", applyZoneOp(["x"], { action: "zone_list", zones: [] }), []);

// ── Sonuç sınıflandırma ──────────────────────────────────────
same(
  "sınıflandırma: -14 retry, -20 retry, -5 unsupported, -18 fatal, -21 fatal",
  [
    classifyZoneResult(resultCodeOf("cihaz mesgul, komut kuyrugu dolu")),
    classifyZoneResult(resultCodeOf("zone kaydedilemedi")),
    classifyZoneResult(resultCodeOf("bilinmeyen action")),
    classifyZoneResult(resultCodeOf("zone gecersiz")),
    classifyZoneResult(resultCodeOf("zone komutu yalnizca cihaz topic'inden kabul edilir")),
  ],
  ["retry", "retry", "unsupported", "fatal", "fatal"],
);

// ── Slug'lar ─────────────────────────────────────────────────
same("grup slug'ı bölgeyle öneklenir, Türkçe → ASCII", groupSlugBase("ekaldes", "Hat A Güney"), "ekaldes-hat-a-guney");
const longZone = "universite-kampusu-ana-giris-yolu"; // 33
const longGroup = groupSlugBase(longZone, "Gece tasarruf hattı");
check(`uzun bölgede grup slug'ı ≤32 ve geçerli (${longGroup})`, longGroup.length <= 32 && isDeviceZoneSlug(longGroup));
check("uzun bölgede ad kısmı en az 6 karakter", longGroup.split("-").slice(-1)[0].length >= 1 && /-gece-t/.test(longGroup), longGroup);
same("ek: taban kısalır, 32 aşılmaz", withSuffix("a".repeat(32), 12).length, 32);
same("ek: tire ile bitmez", fitSlug("ekaldes-hat-"), "ekaldes-hat");
check("cihaz slug kuralı: all / büyük harf / 33 reddedilir", !isDeviceZoneSlug("all") && !isDeviceZoneSlug("Ekaldes") && !isDeviceZoneSlug("a".repeat(33)));

console.log(failures ? `\n${failures} kontrol başarısız` : "\nHepsi geçti");
process.exit(failures ? 1 : 0);
