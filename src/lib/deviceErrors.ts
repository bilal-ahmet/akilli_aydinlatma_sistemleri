/**
 * Cihazın komut yanıtındaki hata metinlerinin kataloğu
 * (`{"status":"error","error":"..."}` → ESP ekibinin hata tablosu).
 *
 * Firmware metinleri Türkçe ama ASCII (şapkasız/noktasız) ve kullanıcıya ham
 * haliyle pek bir şey anlatmıyor. Burada her metni koda, okunur bir başlığa,
 * sebebe ve — mümkünse — ne yapılacağına bağlıyoruz; dashboard bildirimleri ve
 * cihaz rozeti bunu gösteriyor. Tanınmayan metin olduğu gibi geçer, yutulmaz.
 *
 * İki dil: teknik metin (admin + sunucu) ve müşteri kullanıcılarına sade metin
 * (`plain`). Müşteri DALI/kanal/payload gibi terimleri görmez; ham firmware
 * metni de gösterilmez (`describeDeviceError(raw, { technical: false })`).
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

/** Müşteriye gösterilen sade karşılık. */
type Plain = Pick<DeviceErrorInfo, "title" | "cause" | "hint">;

type Entry = Omit<DeviceErrorInfo, "raw" | "known"> & { plain: Plain };

/**
 * Komutun biçimiyle ilgili hatalar (JSON, action alanı, eksik parametre):
 * kullanıcının yapabileceği bir şey yok, destek ekibine iletilmeli.
 */
const PLAIN_PROTOCOL: Plain = {
  title: "Cihaz komutu işleyemedi",
  cause: "Cihaz, gönderilen komutu anlayamadı.",
  hint: "Sorun sürerse teknik destek ile iletişime geçin.",
};

/** Katalogda karşılığı olmayan hata — müşteriye ham metin yerine bu. */
const PLAIN_UNKNOWN: Plain = {
  title: "Cihaz komutu uygulayamadı",
  cause: "Cihaz komutu yerine getiremediğini bildirdi.",
  hint: "Sorun sürerse teknik destek ile iletişime geçin.",
};

/** Birebir eşleşen metinler. */
const EXACT: Record<string, Entry> = {
  "gecersiz json": {
    code: "invalid-json",
    title: "Komut okunamadı",
    cause: "Cihaz gelen mesajı JSON olarak ayrıştıramadı.",
    hint: "Komut backend tarafından üretiliyor; tekrarlıyorsa payload'ı loglayın.",
    plain: PLAIN_PROTOCOL,
  },
  "action alani yok": {
    code: "missing-action",
    title: "Komutta action yok",
    cause: "Payload'da `action` alanı bulunamadı.",
    plain: PLAIN_PROTOCOL,
  },
  "action string degil": {
    code: "invalid-action-type",
    title: "action alanının tipi yanlış",
    cause: "`action` metin (string) olmalı.",
    plain: PLAIN_PROTOCOL,
  },
  "bilinmeyen action": {
    code: "unknown-action",
    title: "Bilinmeyen komut",
    cause: "Cihaz bu `action` değerini tanımıyor.",
    hint: "Firmware sürümü dashboard'ın gönderdiği komutu desteklemiyor olabilir.",
    plain: {
      title: "Cihaz bu komutu desteklemiyor",
      cause: "Cihazın yazılımı bu komutu tanımıyor.",
      hint: "Sorun sürerse teknik destek ile iletişime geçin.",
    },
  },
  "bu channel dali hattinda bulunamadi": {
    code: "channel-not-found",
    title: "Kanal DALI hattında yok",
    cause: "Komutun hedeflediği DALI adresinde bir sürücü bulunamadı.",
    hint: "Lamba listesinden bu kanalı silin ya da adresi düzeltin.",
    plain: {
      title: "Lamba yanıt vermiyor",
      cause: "Komut gönderilen lamba cihazda bulunamadı.",
      hint: "Lamba sökülmüş ya da arızalı olabilir. Sorun sürerse teknik destek ile iletişime geçin.",
    },
  },
  "chase efekti tum lambalari surer, channel gondermeyin": {
    code: "effect-no-channel",
    title: "Bu efekt tek lambaya verilemez",
    cause: "Çok lambalı efekte kanal gönderildi; efekt tüm hattı birlikte sürer.",
    hint: "Efekti tek lamba yerine cihazın tamamına uygulayın.",
    plain: {
      title: "Bu efekt tek lambaya verilemez",
      cause: "Bu efekt cihazdaki tüm lambalarla birlikte çalışır.",
      hint: "Efekti tek lamba yerine cihazın tamamına uygulayın.",
    },
  },
  "efekt baslatilamadi (bos slot yok veya bellek yetersiz)": {
    code: "effect-slots-full",
    title: "Efekt başlatılamadı",
    cause: "Cihazda boş efekt slotu kalmadı (aynı anda en fazla 4 kanal).",
    hint: "Başka bir kanaldaki efekti durdurup tekrar deneyin.",
    plain: {
      title: "Efekt başlatılamadı",
      cause: "Bir cihazda aynı anda en fazla 4 lambada efekt çalışabilir.",
      hint: "Başka bir lambadaki efekti durdurup tekrar deneyin.",
    },
  },
};

/** Değişken içeren (sayı taşıyan) metinler. */
const PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => Entry }> = [
  // `veya 255` kısmı opsiyonel: broadcast 255 kaldırıldıktan sonra firmware
  // metni "(0..63)" olarak kısaldı, eski sürümlerdeki metin de eşleşsin.
  {
    re: /^dim icin value \(0\.\.100\) ve channel \(0\.\.63( veya 255)?\) gerekli$/,
    build: () => ({
      code: "dim-args",
      title: "Dim komutu eksik",
      cause: "`value` (0-100) eksik ya da `channel` aralık dışı (0-63).",
      plain: PLAIN_PROTOCOL,
    }),
  },
  {
    re: /^efekt icin number \(0\.\.(\d+)\) ve channel \(0\.\.63( veya 255)?\) gerekli$/,
    build: (m) => ({
      code: "efekt-args",
      title: "Efekt komutu eksik",
      cause: `\`number\` (0-${m[1]}) eksik ya da \`channel\` aralık dışı (0-63).`,
      hint: "Cihazın desteklemediği bir efekt numarası gönderilmiş olabilir.",
      plain: {
        title: "Efekt başlatılamadı",
        cause: "Cihaz bu efekti desteklemiyor olabilir.",
        hint: "Sorun sürerse teknik destek ile iletişime geçin.",
      },
    }),
  },
  {
    re: /^d4i_read icin channel \(0\.\.63\) gerekli$/,
    build: () => ({
      code: "d4i-read-args",
      title: "D4i okuma komutu eksik",
      cause: "`channel` (0-63) alanı gerekli.",
      plain: PLAIN_PROTOCOL,
    }),
  },
  {
    re: /^bu efekt en az (\d+) lamba ister, hatta (\d+) lamba var$/,
    build: (m) => ({
      code: "not-enough-lamps",
      title: "Efekt için yeterli lamba yok",
      cause: `Efekt en az ${m[1]} lamba istiyor, hatta ${m[2]} lamba var.`,
      hint: "Bu efekti daha çok lambası olan bir cihazda kullanın.",
      plain: {
        title: "Efekt için yeterli lamba yok",
        cause: `Bu efekt en az ${m[1]} lamba ister, cihazda ${m[2]} lamba var.`,
        hint: "Bu efekti daha çok lambası olan bir cihazda kullanın.",
      },
    }),
  },
];

function resolve({ plain, ...entry }: Entry, technical: boolean): Omit<DeviceErrorInfo, "raw" | "known"> {
  return technical ? entry : { code: entry.code, ...plain };
}

/**
 * Ham hata metnini kataloğa bağlar. Tanınmayan metin `known:false` ile döner ve
 * (teknik dilde) ham metni taşır — yeni firmware hataları sessizce kaybolmasın.
 *
 * `technical: false` → müşteriye sade metin; ham metin `raw`'da kalır ama UI
 * bunu müşteriye göstermemeli.
 */
export function describeDeviceError(
  raw: string,
  { technical = true }: { technical?: boolean } = {},
): DeviceErrorInfo {
  const key = normalize(raw);

  const exact = EXACT[key];
  if (exact) return { ...resolve(exact, technical), raw, known: true };

  for (const { re, build } of PATTERNS) {
    const m = key.match(re);
    if (m) return { ...resolve(build(m), technical), raw, known: true };
  }

  return {
    code: "unknown",
    ...(technical ? { title: "Cihaz komutu reddetti", cause: raw } : PLAIN_UNKNOWN),
    raw,
    known: false,
  };
}
