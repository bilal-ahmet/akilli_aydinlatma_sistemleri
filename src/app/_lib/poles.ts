import type { DeviceView, OpenFault, PoleView } from "./types";
import { isOnline } from "./deviceHealth";
import { deviceState } from "./selection";
import { isWarningCode } from "@/lib/faults";

/**
 * Direğin canlı durumu — bağlı cihazdan türetilir (bir direkte tek cihaz).
 * Harita işaretleri, bölge envanteri ve Genel Bakış aynı fonksiyonu kullanır.
 * Mobil uygulamada kopyası var (CLAUDE.md Kural #16).
 *
 * Öncelik: cihaz yok → bağlantı yok → arıza → yanıyor → kapalı.
 */
export type PoleState = "no_device" | "offline" | "fault" | "on" | "off";

export function poleState(
  device: DeviceView | undefined,
  /** Cihazın süren lamba arızaları. */
  faults: OpenFault[],
  now: number | null,
): PoleState {
  if (!device) return "no_device";
  // Saat henüz yoksa (ilk render) bağlantı yargısına varma.
  if (now !== null && !isOnline(device, now)) return "offline";
  if (device.lastError || faults.some((f) => !isWarningCode(f.code))) return "fault";
  return deviceState(device).isOn ? "on" : "off";
}

/** Durumun okunur adı (müşteri ve admin için aynı; teknik terim yok). */
export const POLE_STATE_LABELS: Record<PoleState, string> = {
  no_device: "Cihaz takılı değil",
  offline: "Bağlantı yok",
  fault: "Arıza",
  on: "Yanıyor",
  off: "Kapalı",
};

/**
 * Liste noktası rengi (Tailwind sınıfı). Yanan direk lamba ışığı (amber),
 * bağlantısız direk içi boş kırmızı halka — arızadan ayrılsın.
 */
export const POLE_STATE_DOT: Record<PoleState, string> = {
  no_device: "bg-border-strong",
  offline: "bg-panel ring-[1.5px] ring-inset ring-danger",
  fault: "bg-danger",
  on: "bg-glow",
  off: "bg-muted",
};

/** Cihaz MAC'i → direk durumu hesaplayıcısı (listeler için tek geçişte). */
export function poleStateResolver(
  devices: DeviceView[],
  faultsByDevice: Map<string, OpenFault[]>,
  now: number | null,
): (pole: PoleView) => PoleState {
  const byMac = new Map(devices.map((d) => [d.deviceId, d]));
  return (pole) => {
    const device = pole.deviceId ? byMac.get(pole.deviceId) : undefined;
    return poleState(device, device ? (faultsByDevice.get(device.deviceId) ?? []) : [], now);
  };
}

/**
 * Bölgenin direk sayısı: kayıtlı direk varsa onların sayısı, yoksa bölgeye
 * elle girilen sayı (direkler kaydedilene kadar geçiş dönemi).
 */
export function zonePoleCount(zone: { id: string; poleCount: number }, poles: PoleView[]): number {
  const registered = poles.filter((p) => p.zoneSlug === zone.id).length;
  return registered > 0 ? registered : zone.poleCount;
}

/** Türkiye'nin kaba sınır kutusu — dışındaki koordinat büyük olasılıkla hatalı. */
export function inTurkey(lat: number, lng: number): boolean {
  return lat >= 35.5 && lat <= 42.5 && lng >= 25.5 && lng <= 45;
}

/**
 * Koordinat metnini ayrıştırır: "40.7654, 29.9408" (Google Maps kopyası),
 * "40,7654 29,9408" (ondalık virgül) ya da tek sayı. Geçersizse null.
 */
export function parseCoordinatePair(text: string): { lat: number; lng: number } | null {
  const t = text.trim();
  // Ondalık virgüllü iki sayı: "40,76 29,94" → ayırıcı boşluk ya da ";".
  const parts = /^-?\d+,\d+[\s;]+-?\d+,\d+$/.test(t)
    ? t.split(/[\s;]+/).map((p) => p.replace(",", "."))
    : t.split(/[\s,;]+/);
  if (parts.length !== 2) return null;
  const [lat, lng] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
