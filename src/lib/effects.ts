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
  { number: 1, id: "dali_fx_fade", label: "Fade (Yumuşak geçiş)", desc: "Yavaşça açılıp kapanır" },
  { number: 2, id: "dali_fx_blink", label: "Blink (Yanıp sönme)", desc: "Yarım saniyede bir yanıp söner" },
  { number: 3, id: "dali_fx_strobe", label: "Strobe (Flaş)", desc: "Kısa ve parlak flaşlar çakar" },
  { number: 4, id: "dali_fx_random", label: "Random (Rastgele)", desc: "Rastgele parlaklık değişimi (titreme)" },
  { number: 5, id: "dali_fx_steps", label: "Steps (Basamak)", desc: "Parlaklık dört basamakta duraklayarak değişir" },
  { number: 6, id: "dali_fx_pulse", label: "Pulse (Nabız)", desc: "Yumuşak, düzenli nabız gibi parlayıp söner" },
  { number: 7, id: "dali_fx_heartbeat", label: "Heartbeat (Kalp atışı)", desc: "İki hızlı yanıp sönme, ardından kısa bir ara" },
  { number: 8, id: "dali_fx_candle", label: "Candle (Mum ışığı)", desc: "Mum ışığı gibi hafifçe titrer" },
  { number: 9, id: "dali_fx_sos", label: "SOS (İmdat)", desc: "Mors alfabesiyle imdat işareti (... --- ...)" },
  { number: 10, id: "dali_fx_police", label: "Police (Polis çakarı)", desc: "Üçer üçer hızlı yanıp söner" },
  { number: 11, id: "dali_fx_twinkle", label: "Twinkle (Parıltı)", desc: "Loş ışıkta ara ara parıltılar" },
  { number: 12, id: "dali_fx_lightning", label: "Lightning (Şimşek)", desc: "Karanlıkta ani şimşek çakmaları" },
  { number: 13, id: "dali_fx_disco", label: "Disco (Disko)", desc: "Efektler rastgele art arda değişir" },
  { number: 15, label: "Nefes", desc: "Nefes alıp verir gibi yavaşça parlayıp söner" },
  { number: 16, label: "Deniz feneri", desc: "Deniz feneri gibi düzenli aralıklarla parlar" },
  { number: 17, label: "Gün doğumu", desc: "Karanlıktan tam parlaklığa yavaşça açılır" },
  { number: 18, label: "Alarm", desc: "Hızlı ve kesik uyarı ışıkları" },
  { number: 19, label: "Sekme", desc: "Parlaklık sekerek artıp azalır" },
  { number: 20, label: "Rastgele yürüyüş", desc: "Parlaklık rastgele artıp azalır" },
  { number: 21, label: "Hızlanan", desc: "Yanıp sönme giderek hızlanır" },
  {
    number: 22,
    id: "dali_fx_mors",
    label: "Mors",
    desc: "Yazdığınız metni Mors alfabesiyle yakıp söndürür",
    needsText: true,
  },

  // ── Çok lambalı efektler: channel KABUL ETMEZ, asgari lamba ister ──
  {
    number: 14,
    id: "dali_fx_chase",
    label: "Chase (Kovalamaca)",
    desc: "Lambalar sırayla yanar",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 23,
    label: "Karşılıklı",
    desc: "Lambalar sırayla karşılıklı yanar",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 24,
    label: "Dalga",
    desc: "Parlaklık lambalar boyunca dalga gibi ilerler",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 25,
    label: "Meteor",
    desc: "Kayan bir ışık, arkasında sönen bir iz bırakır",
    allLamps: true,
    minLamps: 3,
  },
  {
    number: 26,
    label: "PingPong (Git-gel)",
    desc: "Işık lambalar arasında gidip gelir",
    allLamps: true,
    minLamps: 3,
  },
  {
    number: 27,
    label: "Doldur",
    desc: "Lambalar sırayla yanarak hepsi yanana kadar dolar",
    allLamps: true,
    minLamps: 2,
  },
  {
    number: 28,
    label: "Rastgele lamba",
    desc: "Her seferinde rastgele bir lamba yanar",
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
