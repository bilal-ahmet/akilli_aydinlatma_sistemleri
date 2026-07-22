/**
 * Işık efekti kataloğu — dashboard ↔ firmware ortak kontratı.
 * Komut: { "action": "efekt", "number": <no> }. `number` 1-tabanlıdır ve
 * bu tablodaki sıraya KİLİTLİDİR; ESP firmware dizisi de bu numaralara hizalı
 * olmalı. Sıra/numara DEĞİŞTİRİLMEMELİ (kontrat).
 *
 * Numaralar bitişik DEĞİL: firmware 1-14'ten sonra 22'yi (Mors) tanımlıyor.
 * 15-21 arası ESP tarafında ne olduğu henüz bildirilmedi; katalogda yer
 * almadıkları için dashboard'da da görünmezler.
 */
export interface Effect {
  number: number; // 1-tabanlı
  id: string; // dali_fx_*
  label: string;
  desc: string;
  /** Efekt `text` parametresi bekliyorsa true (şu an yalnızca Mors). */
  needsText?: boolean;
  /**
   * Efekt doğası gereği hattaki TÜM lambaları birlikte sürüyorsa true.
   * Bu efektlerde komuta `channel` KONMAZ — cihaz aksi halde
   * "chase efekti tum lambalari surer, channel gondermeyin" hatası döner.
   * Ayrıca hatta yeterli lamba yoksa
   * "bu efekt en az N lamba ister, hatta M lamba var" ile reddedilir.
   */
  allLamps?: boolean;
}

export const EFFECTS: readonly Effect[] = [
  { number: 1, id: "dali_fx_fade", label: "Nefes / Fade", desc: "Doğrusal yavaş açılıp kapanma" },
  { number: 2, id: "dali_fx_blink", label: "Blink", desc: "Tam aç/kapa, ~yarım saniye" },
  { number: 3, id: "dali_fx_strobe", label: "Strobe", desc: "Kısa parlak flaşlar" },
  { number: 4, id: "dali_fx_random", label: "Random", desc: "Rastgele parlaklık (titreme)" },
  { number: 5, id: "dali_fx_steps", label: "Steps", desc: "Çeyrek seviyelerde duraklama" },
  { number: 6, id: "dali_fx_pulse", label: "Pulse", desc: "Sinüs eğrili yumuşak nefes" },
  { number: 7, id: "dali_fx_heartbeat", label: "Heartbeat", desc: "İki hızlı vuruş + dinlenme" },
  { number: 8, id: "dali_fx_candle", label: "Candle", desc: "Mum gibi düzensiz titreşim" },
  { number: 9, id: "dali_fx_sos", label: "SOS", desc: "Mors imdat (... --- ...)" },
  { number: 10, id: "dali_fx_police", label: "Police", desc: "Üçlü hızlı flaş" },
  { number: 11, id: "dali_fx_twinkle", label: "Twinkle", desc: "Loş zemin + parıltılar" },
  { number: 12, id: "dali_fx_lightning", label: "Lightning", desc: "Karanlık + ani şimşek" },
  { number: 13, id: "dali_fx_disco", label: "Disco", desc: "Rastgele efekt zinciri" },
  {
    number: 14,
    id: "dali_fx_chase",
    label: "Chase",
    desc: "Lambaları sırayla yakma (tüm hattı sürer)",
    allLamps: true,
  },
  {
    number: 22,
    id: "dali_fx_mors",
    label: "Mors",
    desc: "Yazdığın metni Mors alfabesiyle yakıp söndürür",
    needsText: true,
  },
] as const;

export const EFFECT_COUNT = EFFECTS.length;

/**
 * Kontrattaki en büyük efekt numarası — doğrulama sınırı BUDUR, katalog
 * uzunluğu değil (numaralar bitişik değil: 1-14 ve 22).
 */
export const EFFECT_MAX_NUMBER = EFFECTS.reduce((m, e) => Math.max(m, e.number), 0);

export function effectByNumber(n: number | null | undefined): Effect | undefined {
  return n == null ? undefined : EFFECTS.find((e) => e.number === n);
}

// ── Mors metni ───────────────────────────────────────────────
/** Firmware sınırı: harf, rakam ve boşluk; en fazla 32 karakter. */
export const MORSE_TEXT_MAX = 32;

const TR_TO_ASCII: Record<string, string> = {
  Ç: "C", Ğ: "G", İ: "I", Ö: "O", Ş: "S", Ü: "U",
};

/**
 * Kullanıcı girdisini firmware'in kabul ettiği alfabeye indirger: Türkçe
 * harfler ASCII karşılığına düşer (Mors alfabesinde karşılıkları yok),
 * desteklenmeyen karakterler atılır, 32 karaktere kırpılır.
 */
export function normalizeMorseText(input: string): string {
  return input
    .toLocaleUpperCase("tr-TR")
    .replace(/[ÇĞİÖŞÜ]/g, (c) => TR_TO_ASCII[c] ?? c)
    .replace(/[^A-Z0-9 ]/g, "")
    .slice(0, MORSE_TEXT_MAX);
}
