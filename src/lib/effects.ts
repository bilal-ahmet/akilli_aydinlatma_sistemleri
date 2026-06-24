/**
 * Işık efekti kataloğu — dashboard ↔ firmware ortak kontratı.
 * Komut: { "action": "efekt", "number": <1..14> }. `number` 1-tabanlıdır ve
 * bu tablodaki sıraya KİLİTLİDİR; ESP firmware dizisi de bu numaralara hizalı
 * olmalı. Sıra/numara DEĞİŞTİRİLMEMELİ (kontrat).
 */
export interface Effect {
  number: number; // 1-tabanlı
  id: string; // dali_fx_*
  label: string;
  desc: string;
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
  { number: 14, id: "dali_fx_chase", label: "Chase", desc: "Lambaları sırayla yakma" },
] as const;

export const EFFECT_COUNT = EFFECTS.length;

export function effectByNumber(n: number | null | undefined): Effect | undefined {
  return n == null ? undefined : EFFECTS.find((e) => e.number === n);
}
