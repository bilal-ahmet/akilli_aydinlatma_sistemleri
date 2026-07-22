/**
 * D4i raporundaki ölçümleri okunur değerlere çeviren saf yardımcılar.
 *
 * Sürücü artık LED ölçümlerini kendisi DOĞRULUYOR: güvenmediği değeri `null`'a
 * çekip yanına ham (`*_reported_*`) ve — hesaplayabiliyorsa — tahmini
 * (`*_estimated_*`) değeri koyuyor. Ham değer tek başına yanıltıcı olabiliyor
 * (LED gerilimi 1,8 V, sıcaklık -7 °C gibi), bu yüzden UI her ölçümü
 * "doğrulanmış / tahmini / doğrulanmamış" olarak ayırt eder.
 *
 * `d4iPeriodicSchema` bilinmeyen alanları strip ettiği için bu alanların TEK
 * kaynağı `d4i_telemetry.raw` (ham payload) — bkz. lib/mqtt.ts handleD4i.
 */

/** Ham `d4i` alt bloğu (driver/led): sayı, metin ve boolean karışık gelir. */
export type D4iBlock = Record<string, unknown>;

export function pickNumber(block: D4iBlock | undefined, key: string): number | null {
  const v = block?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function pickBool(block: D4iBlock | undefined, key: string): boolean | null {
  const v = block?.[key];
  return typeof v === "boolean" ? v : null;
}

export function pickString(block: D4iBlock | undefined, key: string): string | null {
  const v = block?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Bir ölçümün gösterilebilir hâli.
 * - `exact`      → sürücünün doğruladığı değer, olduğu gibi yazılır
 * - `estimated`  → sürücünün tahmini; UI'da `≈` ile gösterilir
 * - `unverified` → ham ölçüm, doğrulama başarısız; UI'da `*` ile işaretlenir
 */
export type ReadingKind = "exact" | "estimated" | "unverified";

export interface Reading {
  value: number;
  kind: ReadingKind;
  /** Sürücünün raporladığı ham değer — teknik detayda gösterilir. */
  reported?: number;
  /** Firmware'in verdiği sebep kodu (`load_power_current_mismatch` vb.). */
  reason?: string;
}

/**
 * `name` + `unit` deseniyle bir ölçümü okur (örn. "voltage" + "v" →
 * `voltage_v` / `voltage_estimated_v` / `voltage_reported_v`).
 *
 * Öncelik: doğrulanmış → tahmini → ham. Eski payload'lar yalnızca `voltage_v`
 * gönderdiği için ilk kuraldan geçer, yani geriye uyumludur.
 */
export function readMeasurement(
  block: D4iBlock | undefined,
  name: string,
  unit: string,
): Reading | null {
  if (!block) return null;

  const exact = pickNumber(block, `${name}_${unit}`);
  const estimated = pickNumber(block, `${name}_estimated_${unit}`);
  const reported = pickNumber(block, `${name}_reported_${unit}`);
  const reason =
    pickString(block, `${name}_implausibility_reason`) ??
    pickString(block, `${name}_estimation_reason`) ??
    undefined;

  if (exact !== null) return { value: exact, kind: "exact" };

  if (estimated !== null) {
    return {
      value: estimated,
      kind: "estimated",
      ...(reported !== null ? { reported } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  if (reported !== null) {
    // Doğrulama hiç yapılmadıysa (eski firmware) ham değere güveniriz.
    const plausible = pickBool(block, `${name}_plausible`);
    return {
      value: reported,
      kind: plausible === false ? "unverified" : "exact",
      ...(reason ? { reason } : {}),
    };
  }

  return null;
}

const tr0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

export interface CounterReading {
  /** Ekrana yazılacak metin ("253+" ya da "10"). */
  text: string;
  /** Sayaç tavana ulaşıp saymayı bıraktı mı? */
  saturated: boolean;
  /** Ham sayı — sıfır/dolu ayrımıyla vurgu seçmek için. */
  count: number | null;
}

/**
 * Arıza sayacını okur. DALI sayaçları 1 bayt olduğu için tavana ulaşınca
 * saymayı bırakır; firmware bunu `${key}_count_saturated` ile bildirir ve
 * `${key}_count_text` içinde "253+" gibi hazır metin gönderir.
 */
export function readCounter(block: D4iBlock | undefined, key: string): CounterReading | null {
  const count = pickNumber(block, `${key}_count`);
  if (count === null) return null;

  const saturated = pickBool(block, `${key}_count_saturated`) === true;
  const text = pickString(block, `${key}_count_text`);

  return {
    count,
    saturated,
    text: text ?? (saturated ? `${tr0.format(count)}+` : tr0.format(count)),
  };
}

/**
 * Doğrulama/tahmin sebebi kodlarının kataloğu. `lib/deviceErrors.ts` ile aynı
 * ilke: tanınmayan kod YUTULMAZ, ham haliyle gösterilir — firmware yeni bir
 * sebep eklerse ekranda görürüz.
 */
const REASONS: Record<string, string> = {
  load_power_current_mismatch: "Yük gücü ile akım ölçümü birbirini tutmuyor",
  gear_temperature_mismatch: "Sürücü sıcaklığıyla uyuşmuyor",
  suspected_missing_plus_60_offset: "Sürücü +60 °C ofsetini uygulamamış görünüyor",
};

export function reasonLabel(code: string): string {
  return REASONS[code] ?? code;
}
