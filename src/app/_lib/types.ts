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
}

export interface DeviceView {
  id: string;
  deviceId: string;
  zoneSlug: string | null;
  zoneName: string | null;
  name: string | null;
  lastSeen: string | null;
}

export interface SystemSummary {
  totalPoles: number;
  polesOn: number;
  polesOff: number;
  /** anlık güç tüketimi (kW) */
  powerKw: number;
  alerts: number;
}
