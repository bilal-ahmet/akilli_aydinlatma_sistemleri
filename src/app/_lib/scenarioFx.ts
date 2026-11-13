/**
 * Senaryolar canlandırması için efekt parlaklık eğrileri (saf). Katalog
 * `lib/effects.ts`'tir; buradaki eğriler firmware kodundan değil, katalogdaki
 * ad + açıklamalardan çıkarılmış YAKLAŞIK görselleştirmelerdir. Komut
 * kontratını etkilemez.
 *
 * `fxLevel(n, t, i, count, text)` → 0..1: `t` efekt başladığından beri geçen
 * saniye, `i` direk sırası, `count` direk sayısı. Çok lambalı efektler
 * (`allLamps`) direk sırasını kullanır: gerçekte bir cihazın kendi lambaları
 * arasında çalışırlar, canlandırma bunları direkler arasında gösterir.
 */

const LOW = 0.04;
const TAU = Math.PI * 2;

const frac = (x: number) => x - Math.floor(x);
/** Deterministik [0,1) gürültü. */
const hash = (a: number, b = 0) => frac(Math.sin(a * 12.9898 + b * 78.233) * 43758.5453);
/** Yumuşak (değer gürültüsü) — saniyede `rate` yeni hedef. */
function noise(seed: number, t: number, rate: number): number {
  const k = Math.floor(t * rate);
  const x = frac(t * rate);
  const a = hash(seed, k);
  const b = hash(seed, k + 1);
  return a + (b - a) * (x * x * (3 - 2 * x));
}
/** 0 → 1 → 0 kosinüs dalgası. */
const wave = (t: number, period: number) => 0.5 - 0.5 * Math.cos((TAU * t) / period);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ── Mors ─────────────────────────────────────────────────────
const MORSE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
  I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
  Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
  Y: "-.--", Z: "--..", "0": "-----", "1": ".----", "2": "..---", "3": "...--",
  "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
};
const MORSE_UNIT_S = 0.18;

/** Metni [yanık mı, birim süre] dizisine çevirir (sonda kelime arası boşluk). */
function morseSequence(text: string): [boolean, number][] {
  const seq: [boolean, number][] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const word of words) {
    const letters = [...word].map((c) => MORSE[c]).filter(Boolean);
    letters.forEach((code, li) => {
      [...code].forEach((sym, si) => {
        seq.push([true, sym === "." ? 1 : 3]);
        if (si < code.length - 1) seq.push([false, 1]);
      });
      if (li < letters.length - 1) seq.push([false, 3]);
    });
    seq.push([false, 7]);
  }
  return seq.length ? seq : [[false, 7]];
}

const morseCache = new Map<string, { seq: [boolean, number][]; total: number }>();
function morseLevel(text: string, t: number): number {
  let m = morseCache.get(text);
  if (!m) {
    const seq = morseSequence(text);
    m = { seq, total: seq.reduce((s, [, u]) => s + u, 0) };
    morseCache.set(text, m);
  }
  let u = (t / MORSE_UNIT_S) % m.total;
  for (const [on, len] of m.seq) {
    if (u < len) return on ? 1 : LOW;
    u -= len;
  }
  return LOW;
}

/** Disko'nun art arda çaldığı tek lamba efektleri. */
const DISCO_POOL = [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 15, 16, 18, 19, 21];

export function fxLevel(n: number, t: number, i: number, count: number, text = "MERHABA"): number {
  switch (n) {
    case 1: // Fade
      return 0.05 + 0.95 * wave(t, 4);
    case 2: // Blink: ~0,5 sn aç / kapa
      return frac(t) < 0.5 ? 1 : LOW;
    case 3: // Strobe
      return frac(t / 0.6) < 0.12 ? 1 : LOW;
    case 4: // Random (titreme)
      return 0.15 + 0.85 * hash(i * 7 + 1, Math.floor(t / 0.12));
    case 5: // Steps
      return [0.25, 0.5, 0.75, 1][Math.floor(t / 0.8) % 4];
    case 6: // Pulse
      return 0.12 + 0.88 * Math.pow(wave(t, 1.6), 1.5);
    case 7: {
      // Heartbeat: iki hızlı atım + ara
      const x = frac(t / 1.2) * 1.2;
      return x < 0.12 || (x > 0.24 && x < 0.36) ? 1 : 0.06;
    }
    case 8: // Candle
      return clamp01(
        0.62 + 0.16 * Math.sin(t * 7.3 + i * 1.7) * Math.sin(t * 3.1 + i) + 0.24 * (noise(i * 5 + 3, t, 9) - 0.5),
      );
    case 9: // SOS
      return morseLevel("SOS", t);
    case 10: {
      // Police: üçer üçer
      const x = frac(t / 1.3) * 1.3;
      return x < 0.54 && frac(x / 0.18) < 0.5 ? 1 : LOW;
    }
    case 11: // Twinkle
      return hash(i * 13 + 5, Math.floor(t / 0.25)) > 0.82 ? 1 : 0.18;
    case 12: {
      // Lightning: her döngüde rastgele anda kısa çakmalar
      const cycle = Math.floor(t / 2.2);
      const d = frac(t / 2.2) * 2.2 - hash(cycle, i + 1) * 1.4;
      if (d >= 0 && d < 0.06) return 1;
      if (d >= 0.12 && d < 0.17) return 0.7;
      if (d >= 0.24 && d < 0.3) return 0.95;
      return 0.03;
    }
    case 13: {
      // Disco: efektler rastgele art arda
      const sub = DISCO_POOL[Math.floor(hash(77, Math.floor(t / 3)) * DISCO_POOL.length)];
      return fxLevel(sub, t, i, count, text);
    }
    case 15: // Nefes
      return 0.08 + 0.92 * wave(t, 5);
    case 16: {
      // Deniz feneri
      const x = frac(t / 3) - 0.5;
      return 0.1 + 0.9 * Math.exp(-((x / 0.07) ** 2));
    }
    case 17: {
      // Gün doğumu: 8 sn'de açılır, 2 sn tam
      const x = t % 10;
      return x < 8 ? 0.02 + 0.98 * Math.pow(x / 8, 1.6) : 1;
    }
    case 18: {
      // Alarm: hızlı kesik çakmalar + ara
      const x = frac(t / 0.9) * 0.9;
      return x < 0.5 && frac(x / 0.125) < 0.5 ? 1 : LOW;
    }
    case 19: {
      // Sekme: seken top gibi, giderek alçalan
      const a = 1 - frac(t / 2.4);
      return 0.1 + 0.9 * a * Math.abs(Math.sin((Math.PI * t) / 0.4));
    }
    case 20: // Rastgele yürüyüş
      return 0.2 + 0.8 * noise(i * 3 + 2, t, 1.5);
    case 21: {
      // Hızlanan: 5 sn'de 1 Hz'den ~7 Hz'e
      const x = t % 5;
      return frac(x + 0.6 * x * x) < 0.5 ? 1 : LOW;
    }
    case 22: // Mors
      return morseLevel(text || "MERHABA", t);

    // ── Çok lambalı (sıra kullanır) ──
    case 14: {
      // Chase
      const pos = Math.floor(t / 0.22) % count;
      return i === pos ? 1 : i === (pos - 1 + count) % count ? 0.25 : LOW;
    }
    case 23: // Karşılıklı
      return (i + Math.floor(t / 0.5)) % 2 === 0 ? 1 : LOW;
    case 24: // Dalga
      return 0.08 + 0.92 * Math.pow(0.5 + 0.5 * Math.sin(TAU * (t / 2.2 - i / count)), 1.4);
    case 25: {
      // Meteor: kayan baş + sönen iz
      const d = ((t * 9) % (count + 6)) - i;
      if (d < 0) return LOW;
      return Math.max(LOW, Math.pow(0.55, d));
    }
    case 26: {
      // PingPong
      const per = 2 * (count - 1);
      const x = (t * 6) % per;
      const p = x < count - 1 ? x : per - x;
      return Math.max(LOW, 1 - Math.abs(i - p) * 0.9);
    }
    case 27: // Doldur
      return i < Math.floor(t / 0.3) % (count + 4) ? 1 : LOW;
    case 28: // Rastgele lamba
      return i === Math.floor(hash(55, Math.floor(t / 0.45)) * count) ? 1 : LOW;
    default:
      return 1;
  }
}
