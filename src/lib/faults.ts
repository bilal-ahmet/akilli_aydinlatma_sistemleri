import type { D4iPeriodic } from "@/types/lighting";
import { flagToBool } from "@/types/lighting";
import { pickNumber, type D4iBlock } from "@/lib/d4i";

/**
 * Arıza kataloğu — TEK kaynak. Hem D4i panelindeki rozetler, hem arıza
 * geçmişindeki (`fault_events`) kod→başlık çözümü buradan okur.
 *
 * Kod biçimi: `lamp_failure` (durum baytı/DALI), `driver.<key>` ve `led.<key>`
 * (D4i blokları), `command.<errorCode>` (cihazın komut yanıtı hatası —
 * lib/deviceErrors.ts kodu).
 */

/** DALI sorgu yanıtı "evet" mi: 255 (ya da 1) aktif, 0 değil, null bilinmiyor. */
export function isFlagActive(v: number | null | undefined): boolean {
  return v === 1 || v === 255;
}

export interface FaultKey {
  /** D4i bloğundaki alan adı (`general_failure` …). */
  key: string;
  /** Panelde sayacın üstünde görünen kısa etiket. */
  label: string;
  /** Müşteri kullanıcılarına gösterilen sade etiket (yoksa `label`). */
  plainLabel?: string;
  /** Etiketin yanındaki ⓘ işaretinin açıklaması (tooltip). */
  note?: string;
  /** `note`'un sade karşılığı. */
  plainNote?: string;
}

/** Etiket seçimi: admin teknik, müşteri sade. */
export function faultKeyLabel(f: FaultKey, technical: boolean): string {
  return technical ? f.label : (f.plainLabel ?? f.label);
}

export function faultKeyNote(f: FaultKey, technical: boolean): string | undefined {
  return technical ? f.note : (f.plainNote ?? f.note);
}

/**
 * `general_failure`, sürücünün TUTTUĞU AYRI bir sayaçtır; yan yana duran özel
 * arıza sayaçlarının toplamı değildir (üstelik sayaçlar tavana ulaşınca — saha
 * örneklerinde 253 — saymayı bırakır). UI'da toplam sanılmasın diye not düşülür.
 */
const GENERAL_NOTE =
  "Sürücünün kendi genel arıza sayacı — yandaki arızaların toplamı değildir.";
const GENERAL_NOTE_PLAIN =
  "Güç ünitesinin kendi tuttuğu genel arıza sayısı — yandaki arızaların toplamı değildir.";

const GENERAL = {
  key: "general_failure",
  label: "Genel arıza",
  note: GENERAL_NOTE,
  plainNote: GENERAL_NOTE_PLAIN,
};
const DERATING = { key: "thermal_derating", label: "Termal kısma", plainLabel: "Aşırı ısınma (ışık kısıldı)" };
const SHUTDOWN = { key: "thermal_shutdown", label: "Termal kapanma", plainLabel: "Aşırı ısınma (kapandı)" };

export const DRIVER_FAULTS: FaultKey[] = [
  GENERAL,
  { key: "undervoltage_failure", label: "Düşük gerilim", plainLabel: "Şebeke gerilimi düşük" },
  { key: "overvoltage_failure", label: "Aşırı gerilim", plainLabel: "Şebeke gerilimi yüksek" },
  { key: "power_limitation", label: "Güç sınırlama", plainLabel: "Işık güç sınırı nedeniyle kısıldı" },
  DERATING,
  SHUTDOWN,
];

export const LED_FAULTS: FaultKey[] = [
  GENERAL,
  { key: "short_circuit", label: "Kısa devre", plainLabel: "Kısa devre" },
  { key: "open_circuit", label: "Açık devre", plainLabel: "Bağlantı kopuk" },
  DERATING,
  SHUTDOWN,
];

/** Geçmiş listesinde tek başına anlamlı olması için blok adı da yazılır. */
const LABELS: Record<string, string> = {
  offline: "Çevrimdışı",
  lamp_failure: "Lamba arızası",
  gear_failure: "Balast arızası",
  ...Object.fromEntries(DRIVER_FAULTS.map((f) => [`driver.${f.key}`, `Sürücü · ${f.label}`])),
  ...Object.fromEntries(LED_FAULTS.map((f) => [`led.${f.key}`, `LED · ${f.label}`])),
};

/** Müşteriye sade başlıklar: "Sürücü" yerine "Güç ünitesi", termal yerine ısınma. */
const PLAIN_LABELS: Record<string, string> = {
  offline: "Bağlantı yok",
  lamp_failure: "Lamba arızası",
  gear_failure: "Güç ünitesi arızası",
  ...Object.fromEntries(
    DRIVER_FAULTS.map((f) => [`driver.${f.key}`, `Güç ünitesi · ${f.plainLabel ?? f.label}`]),
  ),
  "led.general_failure": "LED arızası",
  "led.short_circuit": "LED arızası (kısa devre)",
  "led.open_circuit": "LED arızası (bağlantı kopuk)",
  "led.thermal_derating": "LED aşırı ısındı (ışık kısıldı)",
  "led.thermal_shutdown": "LED aşırı ısındı (kapandı)",
};

/**
 * Arıza kodunu okunur başlığa çevirir. Teknik dilde tanınmayan kod ham haliyle
 * döner (yeni kod gözden kaçmasın); müşteriye "Diğer arıza".
 */
export function faultLabel(code: string, technical = true): string {
  const labels = technical ? LABELS : PLAIN_LABELS;
  if (labels[code]) return labels[code];
  // Komut hataları: gövde metni `detail`de zaten var, başlık genel kalır.
  if (code.startsWith("command")) return technical ? "Komut hatası" : "Komut uygulanamadı";
  return technical ? code : "Diğer arıza";
}

/** DALI durum baytı bitleri (IEC 62386 QUERY STATUS) — d4iHasFault ile aynı. */
const STATUS_BIT_GEAR_FAILURE = 0x01;
const STATUS_BIT_LAMP_FAILURE = 0x02;

/**
 * Bir D4i raporunda O AN aktif olan arıza kodları.
 *
 * Sürücü/LED bayrakları `raw` üzerinden okunur: `d4iPeriodicSchema` bilinmeyen
 * alanları (arıza bayrakları ve sayaçları dahil) strip ettiği için parse
 * edilmiş `d` bunları taşımaz — ham payload tek kaynaktır.
 */
export function activeFaultCodes(d: D4iPeriodic, raw: unknown): string[] {
  const codes: string[] = [];

  if (d.online === false) codes.push("offline");

  const s = d.status;
  if (s) {
    const lampFail = flagToBool(s.lamp_failure);
    const byte = typeof s.status === "number" ? s.status : null;
    if (lampFail === true || (byte !== null && (byte & STATUS_BIT_LAMP_FAILURE) !== 0)) {
      codes.push("lamp_failure");
    }
    if (byte !== null && (byte & STATUS_BIT_GEAR_FAILURE) !== 0) codes.push("gear_failure");
  }

  const d4i = (raw as { d4i?: Record<string, unknown> } | null)?.d4i;
  for (const [block, keys] of [
    ["driver", DRIVER_FAULTS],
    ["led", LED_FAULTS],
  ] as const) {
    const b = d4i?.[block] as D4iBlock | undefined;
    if (!b) continue;
    for (const { key } of keys) {
      if (isFlagActive(pickNumber(b, key))) codes.push(`${block}.${key}`);
    }
  }

  return codes;
}
