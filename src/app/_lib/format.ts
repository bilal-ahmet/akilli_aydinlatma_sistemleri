/** Türkçe biçimlendirme yardımcıları (1.248, 78,4 kW vb.). */

import { formatMac } from "@/lib/mac";

/**
 * Cihazın görünen adı: girilmiş isim; yoksa admin'e MAC, müşteriye cihaz
 * kodunun son 4 hanesi ("Cihaz …3456") — müşteri MAC terimini görmez.
 */
export function deviceName(d: { name: string | null; deviceId: string }, technical: boolean): string {
  const name = d.name?.trim();
  if (name) return name;
  return technical ? formatMac(d.deviceId) : `Cihaz …${d.deviceId.slice(-4)}`;
}

const trInt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const trOne = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatInt(value: number): string {
  return trInt.format(value);
}

export function formatKw(value: number): string {
  return `${trOne.format(value)} kW`;
}

/** Süreyi kaba ama okunur biçimde verir: "45 sn", "12 dk", "3 sa 20 dk", "2 gün". */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} sn`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} dk`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rest = min % 60;
    return rest ? `${hours} sa ${rest} dk` : `${hours} sa`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH ? `${days} gün ${restH} sa` : `${days} gün`;
}

/** "22.07.2026 14:35" — arıza geçmişi gibi listelerde kullanılır. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
