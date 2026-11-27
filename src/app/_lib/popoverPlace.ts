/**
 * Harita üstü kartın yeri (saf). Kart, düğümün çevresindeki aday yerlerden
 * kabın içinde kalan ve kaçınılacak noktalarla (BR'ye giden yol) en az
 * çakışanına açılır — Ağ haritası tasarımındaki `placePop` kuralı.
 */
export type PopSide = "left" | "right" | "top" | "bottom";

export interface PopPlacement {
  left: number;
  top: number;
  /** Okun çıktığı kenar: kart düğümün sağındaysa ok solda ("left"). */
  side: PopSide;
  /** Okun kenar boyunca konumu (px). */
  arrow: number;
}

export function placePopover(opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Düğüm yarıçapı + boşluk. */
  gap: number;
  containerWidth: number;
  containerHeight: number;
  avoid: Array<[number, number]>;
}): PopPlacement {
  const { x, y, width: W, height: H, gap, containerWidth: CW, containerHeight: CH, avoid } = opts;
  const cands: Array<[PopSide, number, number]> = [];
  for (const o of [0, 50, 110]) {
    const g = gap + o;
    cands.push(
      ["left", x + g, y - H / 2],
      ["right", x - g - W, y - H / 2],
      ["bottom", x - W / 2, y - g - H],
      ["top", x - W / 2, y + g],
      ["bottom", x - 30, y - g - H],
      ["bottom", x - W + 30, y - g - H],
      ["top", x - 30, y + g],
      ["top", x - W + 30, y + g],
      ["left", x + g, y - 30],
      ["left", x + g, y - H + 30],
      ["right", x - g - W, y - 30],
      ["right", x - g - W, y - H + 30],
    );
  }
  let best: { side: PopSide; L: number; T: number; score: number } | null = null;
  cands.forEach(([side, L, T], i) => {
    const out =
      Math.max(0, 8 - L) + Math.max(0, L + W - CW + 8) + Math.max(0, 8 - T) + Math.max(0, T + H - CH + 8);
    const hit = avoid.filter(([px, py]) => px > L - 10 && px < L + W + 10 && py > T - 10 && py < T + H + 10).length;
    const score = (out > 0 ? 1e7 + out * 1000 : 0) + hit * 1000 + i;
    if (!best || score < best.score) best = { side, L, T, score };
  });
  const b = best!;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const arrow = b.side === "left" || b.side === "right" ? clamp(y - b.T, 16, H - 16) : clamp(x - b.L, 16, W - 16);
  return { left: b.L, top: b.T, side: b.side, arrow };
}
