const TR_MAP: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u",
  Ç: "c", Ğ: "g", İ: "i", Ö: "o", Ş: "s", Ü: "u",
};

/** Türkçe karakterleri ASCII'ye indirger, URL/topic-güvenli slug üretir. */
export function slugify(input: string): string {
  return input
    .trim()
    .replace(/[çğıöşüÇĞİÖŞÜ]/g, (ch) => TR_MAP[ch] ?? ch)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Bölge slug'ı MQTT topic'idir (`Meven:<slug>/cmd`). Aşağıdakiler bölge adı
 * olarak VERİLEMEZ:
 *  - `all`             → `Meven:all/cmd`: TÜM müşterilerin tüm cihazları
 *  - 12 haneli hex     → bir cihazın MAC topic'i ile karışabilir
 *  - `c-` öneki        → ileride müşteri topic'leri (`Meven:c-<müşteri>/cmd`) için ayrıldı
 */
export function isReservedZoneSlug(slug: string): boolean {
  return slug === "all" || /^[0-9a-f]{12}$/.test(slug) || slug.startsWith("c-");
}

/**
 * Cihaza gönderilen topic slug'ının (bölge ve alt grup) en fazla uzunluğu.
 * Firmware NVS'te 1-32 karakter, yalnızca a-z 0-9 - kabul eder
 * (bkz. binproto/command.ts isDeviceZoneSlug).
 */
export const TOPIC_SLUG_MAX = 32;

/** Slug'ı `max`'a sığdırır (sondaki tireler atılır). */
export function fitSlug(slug: string, max = TOPIC_SLUG_MAX): string {
  return slug.slice(0, max).replace(/-+$/g, "");
}

/** `base` + `-N` eki toplamı `max`'ı aşmayacak şekilde taban kısaltılır. */
export function withSuffix(base: string, n: number, max = TOPIC_SLUG_MAX): string {
  if (n <= 1) return fitSlug(base, max);
  const suffix = `-${n}`;
  return `${fitSlug(base, max - suffix.length)}${suffix}`;
}

/**
 * Alt grup slug tabanı: `<bölge slug'ı>-<ad>` (ekaldes-hat-a). Bölgeyle
 * öneklenir ki farklı bölgelerdeki aynı adlı gruplar çakışmasın. 32'ye
 * sığmazsa önce ad kısmı (en az 6 karakter kalır), sonra bölge öneki kısalır.
 */
export function groupSlugBase(zoneSlug: string, name: string, max = TOPIC_SLUG_MAX): string {
  const part = slugify(name) || "grup";
  const minPart = Math.min(part.length, 6);
  const prefixRoom = Math.max(1, max - 1 - minPart);
  const prefix = fitSlug(zoneSlug, prefixRoom);
  const partRoom = max - prefix.length - 1;
  return fitSlug(`${prefix}-${fitSlug(part, partRoom)}`, max);
}
