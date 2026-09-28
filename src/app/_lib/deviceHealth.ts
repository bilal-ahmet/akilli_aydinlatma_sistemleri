import type { DeviceMeasure, DeviceView, OpenFault, Zone } from "./types";
import { formatKw } from "./format";

/**
 * Cihazın "çevrimiçi" sayıldığı pencere. ESP kanal başına ~30 sn'de bir rapor
 * yayınlar; birkaç kaçan rapora (yeniden bağlanma) tolerans bırakılır.
 */
export const ONLINE_WINDOW_MS = 3 * 60_000;

export type HealthTone = "ok" | "warn" | "bad" | "idle";

export interface DeviceHealth {
  label: string;
  tone: HealthTone;
}

/** Durum tonunun metin ve nokta renkleri (Tailwind sınıfları). */
export const TONE_TEXT: Record<HealthTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-danger",
  idle: "text-muted",
};
export const TONE_DOT: Record<HealthTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-danger",
  idle: "bg-muted",
};

export function isOnline(d: DeviceView, now: number | null): boolean {
  if (!d.lastSeen || now === null) return false;
  return now - new Date(d.lastSeen).getTime() < ONLINE_WINDOW_MS;
}

/**
 * Cihaz satırındaki tek durum etiketi — en ciddi olan kazanır:
 * lamba arızası → komut hatası → hiç bağlanmadı → yanıt yok → veri bekleniyor
 * (bağlı ama son 10 dk'da D4i ölçümü yok) → çevrimiçi.
 */
export function deviceHealth(
  d: DeviceView,
  opts: { faults?: OpenFault[]; measure?: DeviceMeasure; now: number | null },
): DeviceHealth {
  const faultyLamps = new Set((opts.faults ?? []).map((f) => f.channel)).size;
  if (faultyLamps > 0) return { label: `Arıza · ${faultyLamps} lamba`, tone: "bad" };
  if (d.lastError) return { label: "Komut hatası", tone: "bad" };
  if (!d.lastSeen) return { label: "Hiç bağlanmadı", tone: "idle" };
  // Saat henüz yoksa (ilk render) yargıya varma.
  if (opts.now === null) return { label: "…", tone: "idle" };
  if (!isOnline(d, opts.now)) return { label: "Yanıt yok", tone: "bad" };
  if (!opts.measure || opts.measure.powerW === null) return { label: "Veri bekleniyor", tone: "warn" };
  return { label: "Çevrimiçi", tone: "ok" };
}

/** "12 sn önce", "3 dk önce", "2 sa önce", "4 gün önce". */
export function formatAgo(iso: string | null, now: number | null): string {
  if (!iso) return "—";
  if (now === null) return "…";
  const sec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec} sn önce`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} dk önce`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} sa önce`;
  return `${Math.floor(hours / 24)} gün önce`;
}

const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Watt'ı okunur birime çevirir: 1 kW altı W, üstü kW. */
export function formatPower(watts: number): string {
  return watts >= 1000 ? formatKw(watts / 1000) : `${tr1.format(watts)} W`;
}

/** Değer + birim ayrı (büyük rakam, küçük birim gösterimi için). */
export function splitPower(watts: number): { value: string; unit: string } {
  return watts >= 1000
    ? { value: tr1.format(watts / 1000), unit: "kW" }
    : { value: tr1.format(watts), unit: "W" };
}

export function formatVolt(v: number, estimated = false): string {
  return `${estimated ? "≈" : ""}${tr1.format(v)} V`;
}

/** Cihaz görünen adı: girilmiş isim, yoksa MAC'in son 4 hanesi. */
export function deviceLabel(d: { name: string | null; deviceId: string }): string {
  return d.name?.trim() || `…${d.deviceId.slice(-4)}`;
}

/**
 * Bir cihaz kümesinin (bölge) ölçüm toplamı: güç toplanır, gerilim lamba
 * ağırlıklı ortalanır. Hiç ölçüm yoksa alanlar null.
 */
export function aggregateMeasures(measures: (DeviceMeasure | undefined)[]): DeviceMeasure {
  let powerW: number | null = null;
  let loadPowerW: number | null = null;
  let voltSum = 0;
  let voltLamps = 0;
  let estimated = false;
  let lamps = 0;
  for (const m of measures) {
    if (!m) continue;
    lamps += m.lamps;
    if (m.powerW !== null) powerW = (powerW ?? 0) + m.powerW;
    if (m.loadPowerW !== null) loadPowerW = (loadPowerW ?? 0) + m.loadPowerW;
    if (m.ledVoltageV !== null) {
      voltSum += m.ledVoltageV * m.ledVoltageLamps;
      voltLamps += m.ledVoltageLamps;
      if (m.ledVoltageEstimated) estimated = true;
    }
  }
  return {
    powerW,
    loadPowerW,
    ledVoltageV: voltLamps > 0 ? voltSum / voltLamps : null,
    ledVoltageLamps: voltLamps,
    ledVoltageEstimated: estimated,
    lamps,
  };
}

/** "Gebze · Osman Yılmaz · 2 direk · 4 cihaz" */
export function zoneMeta(zone: Zone, deviceCount: number): string {
  const parts = [zone.district, `${zone.poleCount} direk`, `${deviceCount} cihaz`];
  return parts.filter(Boolean).join(" · ");
}
