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
