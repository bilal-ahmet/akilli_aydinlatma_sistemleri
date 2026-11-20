/**
 * Yol tarifi yardımcılarının (src/app/_lib/polyline.ts) saf kontrolü.
 * Sunucu/DB/Google gerekmez:  npm run check:route
 */
import { decodePolyline, formatDistance, formatDuration, googleMapsDirUrl } from "../src/app/_lib/polyline";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Google'ın belgesindeki örnek.
const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
const want = [
  { lat: 38.5, lng: -120.2 },
  { lat: 40.7, lng: -120.95 },
  { lat: 43.252, lng: -126.453 },
];
check(
  "polyline: Google örneği 3 nokta",
  pts.length === 3 && pts.every((p, i) => Math.abs(p.lat - want[i].lat) < 1e-9 && Math.abs(p.lng - want[i].lng) < 1e-9),
  JSON.stringify(pts),
);
check("polyline: boş metin", decodePolyline("").length === 0);
check("polyline: yarım metin çökmez", decodePolyline("_p~iF").length === 0);

const dest = { lat: 40.7654, lng: 29.9408 };
check(
  "bağlantı: başlangıçsız (bulunulan konum)",
  googleMapsDirUrl(null, dest, "drive") ===
    "https://www.google.com/maps/dir/?api=1&destination=40.7654%2C29.9408&travelmode=driving",
);
check(
  "bağlantı: nokta + yaya",
  googleMapsDirUrl({ lat: 40.1, lng: 29.2 }, dest, "walk").includes("origin=40.1%2C29.2") &&
    googleMapsDirUrl({ lat: 40.1, lng: 29.2 }, dest, "walk").endsWith("travelmode=walking"),
);
check(
  "bağlantı: adres",
  googleMapsDirUrl({ address: "İzmit Belediyesi" }, dest, "drive").includes("origin=%C4%B0zmit+Belediyesi"),
);

check("mesafe 850 m", formatDistance(847) === "850 m", formatDistance(847));
check("mesafe 2,4 km", formatDistance(2412) === "2,4 km", formatDistance(2412));
check("mesafe 12 km", formatDistance(12_300) === "12 km", formatDistance(12_300));
check("süre 1 dk", formatDuration(20) === "1 dk");
check("süre 47 dk", formatDuration(47 * 60) === "47 dk");
check("süre 1 sa 5 dk", formatDuration(65 * 60) === "1 sa 5 dk");

if (failures) {
  console.error(`\n${failures} kontrol başarısız`);
  process.exit(1);
}
console.log("\nTüm kontroller geçti");
