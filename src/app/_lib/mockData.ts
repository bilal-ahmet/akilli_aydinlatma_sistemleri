import type { Zone, SystemSummary } from "./types";

/** Tek bir direğin tam güçte (100%) yaklaşık tüketimi (kW). */
export const KW_PER_POLE_AT_FULL = 0.12;

export const initialZones: Zone[] = [
  {
    id: "ataturk-bulvari",
    name: "Atatürk Bulvarı",
    district: "Merkez",
    poleCount: 184,
    isOn: true,
    brightness: 85,
    status: "ok",
  },
  {
    id: "istiklal-caddesi",
    name: "İstiklal Caddesi",
    district: "Merkez",
    poleCount: 96,
    isOn: false,
    brightness: 60,
    status: "ok",
  },
  {
    id: "sahil-yolu",
    name: "Sahil Yolu",
    district: "Liman",
    poleCount: 210,
    isOn: true,
    brightness: 40,
    status: "warning",
  },
  {
    id: "cumhuriyet-meydani",
    name: "Cumhuriyet Meydanı",
    district: "Merkez",
    poleCount: 64,
    isOn: true,
    brightness: 100,
    status: "ok",
  },
  {
    id: "sanayi-sitesi",
    name: "Sanayi Sitesi",
    district: "Sanayi",
    poleCount: 142,
    isOn: true,
    brightness: 70,
    status: "fault",
  },
  {
    id: "universite-kampusu",
    name: "Üniversite Kampüsü Yolu",
    district: "Kuzey",
    poleCount: 118,
    isOn: true,
    brightness: 55,
    status: "ok",
  },
  {
    id: "park-girisi",
    name: "Şehir Parkı Girişi",
    district: "Kuzey",
    poleCount: 48,
    isOn: false,
    brightness: 50,
    status: "ok",
  },
  {
    id: "cevre-yolu",
    name: "Çevre Yolu",
    district: "Çevre",
    poleCount: 286,
    isOn: true,
    brightness: 90,
    status: "warning",
  },
];

/** Bir zonun anlık güç tüketimi (kW): açıksa direk × şiddet × katsayı. */
export function zonePowerKw(zone: Zone): number {
  if (!zone.isOn) return 0;
  return zone.poleCount * (zone.brightness / 100) * KW_PER_POLE_AT_FULL;
}

/** Özet metrikler zon durumundan türetilir; sabit değildir. */
export function summarize(zones: Zone[]): SystemSummary {
  let totalPoles = 0;
  let polesOn = 0;
  let powerKw = 0;
  let alerts = 0;

  for (const zone of zones) {
    totalPoles += zone.poleCount;
    if (zone.isOn) polesOn += zone.poleCount;
    powerKw += zonePowerKw(zone);
    if (zone.status !== "ok") alerts += 1;
  }

  return {
    totalPoles,
    polesOn,
    polesOff: totalPoles - polesOn,
    powerKw,
    alerts,
  };
}
