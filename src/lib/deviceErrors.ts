/**
 * Cihazın komut yanıtındaki hata metinlerinin kataloğu
 * (`{"status":"error","error":"..."}` → ESP ekibinin hata tablosu).
 *
 * Firmware metinleri Türkçe ama ASCII (şapkasız/noktasız) ve kullanıcıya ham
 * haliyle pek bir şey anlatmıyor. Burada her metni koda, okunur bir başlığa,
 * sebebe ve — mümkünse — ne yapılacağına bağlıyoruz; dashboard bildirimleri ve
 * cihaz rozeti bunu gösteriyor. Tanınmayan metin olduğu gibi geçer, yutulmaz.
 */

export interface DeviceErrorInfo {
  /** Kısa, stabil kod — UI'da metin yerine bunu dallandırabilirsin. */
  code: string;
  /** Kullanıcıya gösterilen başlık. */
  title: string;
  /** Neden oldu (ESP tablosundaki "Sebep" sütunu). */
  cause: string;
  /** Kullanıcının atabileceği adım; her hata için anlamlı olmayabilir. */
  hint?: string;
  /** Firmware'in gönderdiği ham metin — teşhis için korunur. */
  raw: string;
  /** Katalogda karşılığı bulundu mu? */
  known: boolean;
}

/**
 * Metinleri karşılaştırmadan önce sadeleştirir: firmware sürümleri arasında
 * büyük/küçük harf ve boşluk farkları olabiliyor.
 */
function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

type Entry = Omit<DeviceErrorInfo, "raw" | "known">;

/** Birebir eşleşen metinler. */
const EXACT: Record<string, Entry> = {
  "gecersiz json": {
    code: "invalid-json",
    title: "Komut okunamadı",
    cause: "Cihaz gelen mesajı JSON olarak ayrıştıramadı.",
    hint: "Komut backend tarafından üretiliyor; tekrarlıyorsa payload'ı loglayın.",
  },
  "action alani yok": {
    code: "missing-action",
    title: "Komutta action yok",
    cause: "Payload'da `action` alanı bulunamadı.",
  },
  "action string degil": {
    code: "invalid-action-type",
    title: "action alanının tipi yanlış",
    cause: "`action` metin (string) olmalı.",
  },
  "bilinmeyen action": {
    code: "unknown-action",
    title: "Bilinmeyen komut",
    cause: "Cihaz bu `action` değerini tanımıyor.",
    hint: "Firmware sürümü dashboard'ın gönderdiği komutu desteklemiyor olabilir.",
  },
  "bu channel dali hattinda bulunamadi": {
    code: "channel-not-found",
    title: "Kanal DALI hattında yok",
    cause: "Komutun hedeflediği DALI adresinde bir sürücü bulunamadı.",
    hint: "Lamba listesinden bu kanalı silin ya da adresi düzeltin.",
  },
  "chase efekti tum lambalari surer, channel gondermeyin": {
    code: "effect-no-channel",
    title: "Bu efekt tek lambaya verilemez",
    cause: "Çok lambalı efekte kanal gönderildi; efekt tüm hattı birlikte sürer.",
    hint: "Efekti tek lamba yerine cihazın tamamına uygulayın.",
  },
  "efekt baslatilamadi (bos slot yok veya bellek yetersiz)": {
    code: "effect-slots-full",
    title: "Efekt başlatılamadı",
    cause: "Cihazda boş efekt slotu kalmadı (aynı anda en fazla 4 kanal).",
    hint: "Başka bir kanaldaki efekti durdurup tekrar deneyin.",
  },
};

/** Değişken içeren (sayı taşıyan) metinler. */
const PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Entry }> = [
  {
    re: /^dim icin value \(0\.\.100\) ve channel \(0\.\.63 veya 255\) gerekli$/,
    build: () => ({
      code: "dim-args",
      title: "Dim komutu eksik",
      cause: "`value` (0-100) ya da `channel` (0-63 / 255) eksik veya aralık dışı.",
    }),
  },
  {
    re: /^efekt icin number \(0\.\.(\d+)\) ve channel \(0\.\.63 veya 255\) gerekli$/,
    build: (m) => ({
      code: "efekt-args",
      title: "Efekt komutu eksik",
      cause: `\`number\` (0-${m[1]}) ya da \`channel\` (0-63 / 255) eksik veya aralık dışı.`,
      hint: "Cihazın desteklemediği bir efekt numarası gönderilmiş olabilir.",
    }),
  },
  {
    re: /^d4i_read icin channel \(0\.\.63\) gerekli$/,
    build: () => ({
      code: "d4i-read-args",
      title: "D4i okuma komutu eksik",
      cause: "`channel` (0-63) alanı gerekli.",
    }),
  },
  {
    re: /^bu efekt en az (\d+) lamba ister, hatta (\d+) lamba var$/,
    build: (m) => ({
      code: "not-enough-lamps",
      title: "Efekt için yeterli lamba yok",
      cause: `Efekt en az ${m[1]} lamba istiyor, hatta ${m[2]} lamba var.`,
      hint: "Bu efekti daha çok lambası olan bir cihazda kullanın.",
    }),
  },
];

/**
 * Ham hata metnini kataloğa bağlar. Tanınmayan metin `known:false` ile döner ve
 * başlık olarak ham metni taşır — yeni firmware hataları sessizce kaybolmasın.
 */
export function describeDeviceError(raw: string): DeviceErrorInfo {
  const key = normalize(raw);

  const exact = EXACT[key];
  if (exact) return { ...exact, raw, known: true };

  for (const { re, build } of PATTERNS) {
    const m = key.match(re);
    if (m) return { ...build(m), raw, known: true };
  }

  return {
    code: "unknown",
    title: "Cihaz komutu reddetti",
    cause: raw,
    raw,
    known: false,
  };
}
