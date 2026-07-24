/**
 * Bölge formundaki il / ilçe / mahalle açılır menülerinin veri kaynağı.
 * Şimdilik yalnızca Kocaeli ve ilçe/mahalleleri (temsilî bir alt küme) tanımlı;
 * il seçimi genişletilirse buraya yeni iller eklenir.
 *
 * Not: Bu bilgi `zones.district` alanına `İlçe · Mahalle` biçiminde birleşik
 * yazılır (ayrı bir migration gerekmesin diye). Ayırıcı `LOCATION_SEP`.
 */

export const PROVINCE = "Kocaeli";

/** İl → ilçe → mahalleler. */
export const PROVINCES: Record<string, Record<string, string[]>> = {
  Kocaeli: {
    İzmit: [
      "Yenişehir",
      "Ömerağa",
      "Cedit",
      "Kozluk",
      "Tepecik",
      "Körfez",
      "Yahyakaptan",
      "Alikahya",
      "Serdar",
      "Gündoğdu",
      "Yeşilova",
      "Durhasan",
    ],
    Gebze: [
      "Hacıhalil",
      "Sultan Orhan",
      "Osman Yılmaz",
      "Mustafapaşa",
      "Beylikbağı",
      "Güzeller",
      "Tavşanlı",
      "Cumhuriyet",
      "Yenikent",
      "Arapçeşme",
    ],
    Darıca: [
      "Bağlarbaşı",
      "Osmangazi",
      "Fatih",
      "Kazım Karabekir",
      "Piri Reis",
      "Emek",
      "Cami",
      "Nenehatun",
      "Abdi İpekçi",
    ],
    Körfez: [
      "Yavuz Sultan Selim",
      "Yeni Yalı",
      "Güney",
      "Kuzey",
      "Fatih",
      "Hereke",
      "Şirinyalı",
      "Çamlıca",
      "Yarımca",
    ],
    Gölcük: [
      "Merkez",
      "Değirmendere",
      "Ulaşlı",
      "Halıdere",
      "İhsaniye",
      "Yazıköy",
      "Saraylı",
      "Şirinköy",
    ],
    Derince: [
      "Çenedağ",
      "Sırrıpaşa",
      "Deniz",
      "Yenikent",
      "Çınarlı",
      "Sopalı",
      "Tavşantepe",
      "Dumlupınar",
    ],
    Kartepe: [
      "Uzuntarla",
      "Köseköy",
      "Maşukiye",
      "Suadiye",
      "Acısu",
      "Nusretiye",
      "Emek",
      "Fatih Sultan Mehmet",
    ],
    Başiskele: [
      "Yuvacık",
      "Kullar",
      "Bahçecik",
      "Karşıyaka",
      "Serdar",
      "Yeniköy",
      "Barbaros",
      "Vezirçiftliği",
    ],
    Çayırova: [
      "Akse",
      "Şekerpınar",
      "Özgürlük",
      "Cumhuriyet",
      "Emek",
      "İnönü",
      "Atatürk",
      "Yenimahalle",
    ],
    Dilovası: [
      "Mimar Sinan",
      "Yeni Yıldız",
      "Diliskelesi",
      "Tavşancıl",
      "Orhangazi",
      "Turgut Özal",
      "Çerkeşli",
    ],
    Karamürsel: [
      "Kayacık",
      "İnönü",
      "4 Temmuz",
      "Tepeköy",
      "Ereğli",
      "Akarca",
      "Dereköy",
      "Kızderbent",
    ],
    Kandıra: [
      "Akdurak",
      "Bağırganlı",
      "Kaymalı",
      "Cebeci",
      "Sarısu",
      "Kefken",
      "Merkez",
      "Ballar",
    ],
  },
};

/** İlçe ile mahalleyi birleştirirken (ve ayrıştırırken) kullanılan ayırıcı. */
export const LOCATION_SEP = " · ";

/** Açılır menüdeki il adları. */
export function provinceNames(): string[] {
  return Object.keys(PROVINCES);
}

/** Bir ilin ilçeleri. */
export function districtsOf(province: string): string[] {
  return Object.keys(PROVINCES[province] ?? {});
}

/** Bir ilçenin mahalleleri. */
export function neighborhoodsOf(province: string, district: string): string[] {
  return PROVINCES[province]?.[district] ?? [];
}

/** İlçe + mahalleyi `district` alanına yazılacak tek metne çevirir. */
export function composeLocation(district: string, neighborhood: string): string {
  return [district, neighborhood].filter(Boolean).join(LOCATION_SEP);
}

/**
 * `district` alanındaki birleşik metni tekrar ilçe/mahalleye ayırır (düzenleme
 * formunu ön-seçmek için). Bilinen bir Kocaeli ilçe/mahallesine denk gelmezse
 * boş döner — eski serbest metinli kayıtlar yeniden seçilir.
 */
export function parseLocation(
  value: string | null | undefined,
): { district: string; neighborhood: string } {
  const empty = { district: "", neighborhood: "" };
  if (!value) return empty;
  const [district = "", neighborhood = ""] = value.split(LOCATION_SEP).map((s) => s.trim());
  const known = PROVINCES[PROVINCE]?.[district];
  if (!known) return empty;
  if (neighborhood && !known.includes(neighborhood)) return { district, neighborhood: "" };
  return { district, neighborhood };
}
