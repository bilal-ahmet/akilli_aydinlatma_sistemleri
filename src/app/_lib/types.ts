export type ThemeMode = "light" | "dark" | "auto";

export type ZoneStatus = "ok" | "warning" | "fault";

export interface Zone {
  id: string;
  name: string;
  district: string;
  poleCount: number;
  isOn: boolean;
  /** 0–100 ışık şiddeti */
  brightness: number;
  status: ZoneStatus;
  /** Aktif efekt numarası (1-14) veya null/undefined */
  activeFx?: number | null;
}

export interface DeviceView {
  id: string;
  deviceId: string; // MAC (iki noktasız)
  zoneSlug: string | null;
  zoneName: string | null;
  name: string | null;
  lastSeen: string | null;
  // En güncel device_status'tan (varsa)
  brightness: number | null;
  relayStatus: string | null; // on | off
  temperature: number | null;
  rssi: number | null;
}

export interface SystemSummary {
  totalPoles: number;
  polesOn: number;
  polesOff: number;
  /** anlık güç tüketimi (kW) */
  powerKw: number;
  alerts: number;
}
