import type { PoleState } from "./poles";

/**
 * Haritadaki direk durum renkleri. Hex: harita motorları (MapLibre, three.js)
 * temadaki oklch değerlerini okuyamaz.
 */
export const POLE_COLOR: Record<PoleState, string> = {
  on: "#f0a31a",
  off: "#8f8a80",
  fault: "#d63a2f",
  offline: "#ffffff",
  no_device: "#cfcac0",
};

export const POLE_RED = "#d63a2f";

/** 3B direkte armatür gövdesi + ışık yüzeyi rengi (duruma göre). */
export function poleHeadColors(state: PoleState, dark: boolean): { head: string; lens: string } {
  switch (state) {
    case "on":
      return { head: "#f0a31a", lens: "#ffe08a" };
    case "fault":
      return { head: POLE_RED, lens: "#ff8a80" };
    case "offline":
      return { head: dark ? "#6f6b63" : "#a39e94", lens: POLE_RED };
    case "no_device":
      return { head: "#cfcac0", lens: "#e4e0d8" };
    default:
      return { head: dark ? "#8f8a80" : "#5b5750", lens: dark ? "#5b5750" : "#8f8a80" };
  }
}
