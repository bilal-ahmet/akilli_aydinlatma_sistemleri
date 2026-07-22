/**
 * Işık efekti kataloğu — dashboard ↔ firmware ortak kontratı.
 * Komut: { "action": "efekt", "number": <no> }. `number` 1-tabanlıdır ve
 * bu tablodaki numaralara KİLİTLİDİR; ESP firmware dizisi de bu numaralara
 * hizalı olmalı. Numaralar DEĞİŞTİRİLMEMELİ (kontrat).
 *
 * İki aile var:
 *  - 1-22  : tek lamba efektleri — `channel` ile tek DALI adresine verilebilir.
 *  - 14, 23-28 : çok lambalı efektler (`allLamps`) — hattın tamamını birlikte
 *    sürerler, `channel` KABUL ETMEZLER ve asgari lamba sayısı isterler.
 *
 * Numaralar 1-28 arasını kesintisiz kapsar; katalog DİZİSİ ise numara sırasında
 * değil, aileye göre gruplu (14, çok lambalı grubun içinde).
 */
export interface Effect {
  number: number; // 1-tabanlı
  /**
   * Firmware fonksiyon adı (`dali_fx_*`). 15+ numaralı efektler için ESP
   * ekibi fonksiyon adı bildirmedi; yalnızca belge amaçlı, kodda kullanılmıyor.
   */
  id?: string;
  label: string;
  desc: string;
  /** Efekt `text` parametresi bekliyorsa true (şu an yalnızca Mors). */
  needsText?: boolean;
  /**
   * Efekt doğası gereği hattaki TÜM lambaları birlikte sürüyorsa true.
   * Bu efektlerde komuta `channel` KONMAZ — cihaz aksi halde
   * "chase efekti tum lambalari surer, channel gondermeyin" hatası döner.
   */
  allLamps?: boolean;
  /**
   * Efektin çalışması için hatta olması gereken en az lamba sayısı. Yetersizse
   * cihaz "bu efekt en az N lamba ister, hatta M lamba var" ile reddeder;
   * dashboard bu efektleri baştan pasif gösterir.
   */
  minLamps?: number;
}

/*
 * Not: 15-21 ve 23-28 için ESP ekibi yalnızca NUMARA + AD (+ asgari lamba)
 * bildirdi. `desc` metinleri addan çıkarılmış açıklamalardır — efektin gerçek
 * davranışı farklıysa yalnızca bu satırlar düzeltilir, numaralar sabit kalır.
 */
export const EFFECTS: readonly Effect[] = [
  // ── Tek lamba efektleri (channel ile tek adrese verilebilir) ──
  { number: 1, id: "dali_fx_fade", label: "Fade", desc: "Doğrusal yavaş açılıp kapanma" },
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
  { number: 15, label: "Nefes", desc: "Yumuşak nefes alıp verme" },
  { number: 16, label: "Deniz feneri", desc: "Fener gibi tarayan düzenli parlama" },
  { number: 17, label: "Gün doğumu", desc: "Karanlıktan tam parlaklığa yavaş yükseliş" },
  { number: 18, label: "Alarm", desc: "Hızlı, kesik uyarı flaşları" },
  { number: 19, label: "Sekme", desc: "Seviyeler arasında sekerek gidiş geliş" },
  { number: 20, label: "Rastgele yürüyüş", desc: "Parlaklık rastgele adımlarla gezinir" },
  { number: 21, label: "Hızlanan", desc: "Giderek hızlanan yanıp sönme" },
  {
    number: 22,
    id: "dali_fx_mors",
    label: "Mors",
    desc: "Yazdığın metni Mors alfabesiyle yakıp söndürür",
    needsText: true,
  },

  // ── Çok lambalı efektler: channel KABUL ETMEZ, asgari lamba ister ──
  {
    number: 14,
    id: "dali_fx_chase",
    label: "Chase",
    desc: "Lambaları sırayla yakar",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 23,
    label: "Karşılıklı",
    desc: "Lambalar dönüşümlü olarak karşılıklı yanar",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 24,
    label: "Dalga",
    desc: "Parlaklık hat boyunca dalga gibi ilerler",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 25,
    label: "Meteor",
    desc: "Kayan ışık, arkasında sönen kuyruk bırakır",
    allLamps: true,
    minLamps: 3,
  },
  {
    number: 26,
    label: "PingPong",
    desc: "Işık hat üzerinde gidip gelir",
    allLamps: true,
    minLamps: 3,
  },
  {
    number: 27,
    label: "Doldur",
    desc: "Lambalar sırayla yanıp hattı doldurur",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 28,
    label: "Rastgele lamba",
    desc: "Rastgele seçilen lamba yanar",
    allLamps: true,
    minLamps: 2,
  },
] as const;

export const EFFECT_COUNT = EFFECTS.length;

/**
 * Kontrattaki en büyük efekt numarası — doğrulama sınırı BUDUR, katalog
 * uzunluğu (`EFFECT_COUNT`) değil. Şu an ikisi de 28; ama numara atlanırsa ya
 * da katalogdan bir efekt çıkarılırsa yalnızca bu değer doğru kalır.
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
