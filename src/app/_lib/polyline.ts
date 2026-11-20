/**
 * Yol tarifi yardımcıları (saf; istemci ve testler kullanır).
 *
 * - `decodePolyline`: Google "encoded polyline" biçimini (Routes API
 *   `encodedPolyline`, 1e5 hassasiyet) noktalara çevirir. Maps JS'in
 *   `geometry` kütüphanesini ayrıca yüklememek için burada.
 * - `googleMapsDirUrl`: Google Maps URLs yol tarifi bağlantısı (ücretsiz,
 *   API anahtarı istemez). Telefonda Google Haritalar uygulamasını açar.
 */

export type LatLng = { lat: number; lng: number };

export function decodePolyline(encoded: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (i >= encoded.length) return null;
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

export type DirOrigin = LatLng | { address: string } | null;

/**
 * Google Haritalar yol tarifi bağlantısı. `origin` null ise Google bulunulan
 * konumu kullanır.
 */
export function googleMapsDirUrl(origin: DirOrigin, dest: LatLng, mode: "drive" | "walk"): string {
  const p = new URLSearchParams({ api: "1" });
  if (origin) p.set("origin", "address" in origin ? origin.address : `${origin.lat},${origin.lng}`);
  p.set("destination", `${dest.lat},${dest.lng}`);
  p.set("travelmode", mode === "walk" ? "walking" : "driving");
  return `https://www.google.com/maps/dir/?${p.toString()}`;
}

/** "850 m", "2,4 km", "12 km" */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  return `${km.toLocaleString("tr-TR", { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

/** "1 dk", "47 dk", "1 sa 5 dk" */
export function formatDuration(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} sa ${rest} dk` : `${h} sa`;
}
