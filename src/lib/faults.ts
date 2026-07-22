import type { D4iPeriodic } from "@/types/lighting";
import { flagToBool } from "@/types/lighting";

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
  /** Panelde rozet üstünde görünen kısa etiket. */
  label: string;
}

export const DRIVER_FAULTS: FaultKey[] = [
  { key: "general_failure", label: "Genel arıza" },
  { key: "undervoltage_failure", label: "Düşük gerilim" },
  { key: "overvoltage_failure", label: "Aşırı gerilim" },
  { key: "power_limitation", label: "Güç sınırlama" },
  { key: "thermal_derating", label: "Termal kısma" },
  { key: "thermal_shutdown", label: "Termal kapanma" },
];

export const LED_FAULTS: FaultKey[] = [
  { key: "general_failure", label: "Genel arıza" },
  { key: "short_circuit", label: "Kısa devre" },
  { key: "open_circuit", label: "Açık devre" },
  { key: "thermal_derating", label: "Termal kısma" },
  { key: "thermal_shutdown", label: "Termal kapanma" },
];

/** Geçmiş listesinde tek başına anlamlı olması için blok adı da yazılır. */
const LABELS: Record<string, string> = {
  offline: "Çevrimdışı",
  lamp_failure: "Lamba arızası",
  gear_failure: "Balast arızası",
  ...Object.fromEntries(DRIVER_FAULTS.map((f) => [`driver.${f.key}`, `Sürücü · ${f.label}`])),
  ...Object.fromEntries(LED_FAULTS.map((f) => [`led.${f.key}`, `LED · ${f.label}`])),
};

/** Arıza kodunu okunur başlığa çevirir; tanınmayan kod ham haliyle döner. */
export function faultLabel(code: string): string {
  if (LABELS[code]) return LABELS[code];
  // Komut hataları: gövde metni `detail`de zaten var, başlık genel kalır.
  if (code.startsWith("command")) return "Komut hatası";
  return code;
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
    const b = d4i?.[block] as Record<string, number | null> | undefined;
    if (!b) continue;
    for (const { key } of keys) {
      if (isFlagActive(b[key])) codes.push(`${block}.${key}`);
    }
  }

  return codes;
}
