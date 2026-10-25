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

/** Arızanın hangi parçaya ait olduğu — listelerde başlığın yanında gösterilir. */
export type FaultCategory = "connection" | "lamp" | "driver" | "led" | "command";

const CATEGORY_LABELS: Record<FaultCategory, { technical: string; plain: string }> = {
  connection: { technical: "DALI bağlantısı", plain: "Bağlantı" },
  lamp: { technical: "Lamba", plain: "Lamba" },
  driver: { technical: "Sürücü", plain: "Güç ünitesi" },
  led: { technical: "LED modülü", plain: "LED" },
  command: { technical: "Komut", plain: "Komut" },
};

export function faultCategory(code: string): FaultCategory {
  if (code === "offline") return "connection";
  if (code === "lamp_failure") return "lamp";
  if (code === "gear_failure" || code.startsWith("driver.")) return "driver";
  if (code.startsWith("led.")) return "led";
  return "command";
}

export function faultCategoryLabel(category: FaultCategory, technical = true): string {
  return CATEGORY_LABELS[category][technical ? "technical" : "plain"];
}

/**
 * Sürücünün kendini koruduğu durumlar arıza değil uyarıdır: ışık hâlâ yanıyor
 * ama kısılmış.
 */
const WARNING_CODES = new Set(["driver.thermal_derating", "driver.power_limitation", "led.thermal_derating"]);

export function isWarningCode(code: string): boolean {
  return WARNING_CODES.has(code);
}

interface FaultText {
  /** Ne oluyor. */
  what: string;
  /** Ne yapılmalı (yoksa gösterilmez). */
  hint?: string;
}

/** Kod → açıklama. Teknik metin admin'e, `plain` müşteriye. */
const DESCRIPTIONS: Record<string, { technical: FaultText; plain: FaultText }> = {
  offline: {
    technical: {
      what: "ESP bu DALI adresindeki sürücüden yanıt alamıyor (online: false).",
      hint: "Sürücünün enerjisini ve DALI hattını kontrol edin; adres değiştiyse lamba taraması yapın.",
    },
    plain: {
      what: "Cihaz bu lambaya ulaşamıyor.",
      hint: "Lambanın elektriği kesik ya da bağlantı kablosu kopuk olabilir; saha kontrolü gerekir.",
    },
  },
  lamp_failure: {
    technical: {
      what: "Sürücü lamba arızası bildiriyor (lamp_failure / durum baytı 0x02).",
      hint: "LED modülü ve sürücü çıkışı kontrol edilmeli.",
    },
    plain: {
      what: "Lamba yanmıyor ya da LED modülü arızalı.",
      hint: "Saha kontrolü gerekir; LED modülünün değişmesi gerekebilir.",
    },
  },
  gear_failure: {
    technical: {
      what: "DALI durum baytında sürücü (control gear) arıza biti aktif (0x01).",
      hint: "Sürücü kontrol edilmeli; sürüyorsa değişimi gerekebilir.",
    },
    plain: {
      what: "Lambanın güç ünitesi arıza bildiriyor.",
      hint: "Güç ünitesinin kontrol edilmesi gerekir.",
    },
  },
  "driver.general_failure": {
    technical: {
      what: "Sürücünün D4i genel arıza bayrağı aktif.",
      hint: "Ayrıntı için cihazın Telemetri sekmesindeki diğer bayraklara ve sayaçlara bakın.",
    },
    plain: { what: "Güç ünitesi genel bir arıza bildiriyor.", hint: "Sorun sürerse saha kontrolü gerekir." },
  },
  "driver.undervoltage_failure": {
    technical: {
      what: "Sürücü girişindeki şebeke gerilimi alt sınırın altında.",
      hint: "Hat gerilimini ölçün; aynı hattaki başka lambalarda da varsa sorun şebekededir.",
    },
    plain: {
      what: "Lambaya gelen şebeke elektriği düşük.",
      hint: "Aynı bölgedeki başka lambalarda da görülüyorsa sorun elektrik şebekesinde olabilir.",
    },
  },
  "driver.overvoltage_failure": {
    technical: {
      what: "Sürücü girişindeki şebeke gerilimi üst sınırın üstünde.",
      hint: "Sürücü zarar görebilir; hat gerilimi ölçülmeli.",
    },
    plain: {
      what: "Lambaya gelen şebeke elektriği yüksek.",
      hint: "Güç ünitesi zarar görebilir; elektrik hattının kontrol edilmesi gerekir.",
    },
  },
  "driver.power_limitation": {
    technical: {
      what: "Sürücü çıkış gücünü sınırlıyor; ışık istenen seviyenin altında olabilir.",
      hint: "Genelde geçicidir; sık tekrarlanıyorsa yük ve sürücü uyumunu kontrol edin.",
    },
    plain: {
      what: "Güç ünitesi kendini korumak için ışığı kıstı. Lamba yanmaya devam ediyor.",
      hint: "Genelde kendiliğinden düzelir; sık tekrarlanırsa kontrol ettirin.",
    },
  },
  "driver.thermal_derating": {
    technical: {
      what: "Sürücü sıcaklık sınırına yaklaştığı için çıkışı kısıyor.",
      hint: "Soğuyunca kalkar; sürekli tekrarlıyorsa armatür havalandırmasını kontrol edin.",
    },
    plain: {
      what: "Güç ünitesi ısındığı için ışığı kıstı. Lamba yanmaya devam ediyor.",
      hint: "Soğuyunca kendiliğinden düzelir; sık tekrarlanırsa kontrol ettirin.",
    },
  },
  "driver.thermal_shutdown": {
    technical: {
      what: "Sürücü aşırı sıcaklık nedeniyle çıkışı kapattı.",
      hint: "Soğuyunca yeniden açılabilir; tekrarlıyorsa saha kontrolü gerekir.",
    },
    plain: {
      what: "Güç ünitesi aşırı ısındığı için lamba kapandı.",
      hint: "Soğuyunca yeniden yanabilir; tekrarlıyorsa saha kontrolü gerekir.",
    },
  },
  "led.general_failure": {
    technical: {
      what: "LED modülünün D4i genel arıza bayrağı aktif.",
      hint: "Ayrıntı için cihazın Telemetri sekmesindeki LED bayraklarına bakın.",
    },
    plain: { what: "LED modülü arıza bildiriyor.", hint: "Sorun sürerse saha kontrolü gerekir." },
  },
  "led.short_circuit": {
    technical: { what: "LED çıkışında kısa devre algılandı.", hint: "LED modülü ve kablolama kontrol edilmeli." },
    plain: { what: "LED modülünde kısa devre var; lamba yanmayabilir.", hint: "Saha kontrolü gerekir." },
  },
  "led.open_circuit": {
    technical: {
      what: "LED çıkışında açık devre: yük bağlı değil ya da kablo kopuk.",
      hint: "Sürücü-LED bağlantısını ve LED modülünü kontrol edin.",
    },
    plain: {
      what: "LED modülüne giden bağlantı kopuk; lamba yanmıyor.",
      hint: "Kablo bağlantısının ve LED modülünün kontrol edilmesi gerekir.",
    },
  },
  "led.thermal_derating": {
    technical: {
      what: "LED modülü sıcaklık sınırına yaklaştığı için akım kısılıyor.",
      hint: "Soğuyunca kalkar; sürekli tekrarlıyorsa soğutucu/havalandırmayı kontrol edin.",
    },
    plain: {
      what: "LED ısındığı için ışık kısıldı. Lamba yanmaya devam ediyor.",
      hint: "Soğuyunca kendiliğinden düzelir; sık tekrarlanırsa kontrol ettirin.",
    },
  },
  "led.thermal_shutdown": {
    technical: {
      what: "LED modülü aşırı sıcaklık nedeniyle kapatıldı.",
      hint: "Soğuyunca yeniden açılabilir; tekrarlıyorsa saha kontrolü gerekir.",
    },
    plain: {
      what: "LED aşırı ısındığı için lamba kapandı.",
      hint: "Soğuyunca yeniden yanabilir; tekrarlıyorsa saha kontrolü gerekir.",
    },
  },
};

/** Arızanın açıklaması ve önerilen adım; katalogda yoksa null. */
export function faultDescription(code: string, technical = true): FaultText | null {
  const d = DESCRIPTIONS[code];
  return d ? d[technical ? "technical" : "plain"] : null;
}

/** DALI durum baytı bitleri (IEC 62386 QUERY STATUS). */
const STATUS_BIT_GEAR_FAILURE = 0x01;
const STATUS_BIT_LAMP_FAILURE = 0x02;

/**
 * Bir D4i raporunda O AN aktif olan arıza kodları. Arıza geçmişi, lamba
 * rozeti (`fixtures.status`) ve bölge durumu hep bu listeden karar verir.
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
