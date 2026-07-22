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
  /** Cihazın son komut yanıtı hataysa metni; sonraki başarılı yanıtta temizlenir. */
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * Bir DALI adresinin (lambanın) son D4i raporu — cihaz modalindeki detay
 * paneli bunu gösterir. `raw`, cihazın gönderdiği `d4i` bloğunun tamamıdır
 * (sürücü/LED arıza sayaçları dahil).
 */
export interface D4iSnapshot {
  channel: number;
  online: boolean | null;
  d4iSupported: boolean;
  actualLevel: number | null;
  minLevel: number | null;
  maxLevel: number | null;
  physicalMinLevel: number | null;
  lampFailure: boolean | null;
  lampPowerOn: boolean | null;
  controlGearPresent: boolean | null;
  energyWh: number | null;
  powerW: number | null;
  driverTemperatureC: number | null;
  driverVoltageV: number | null;
  driverOperatingTimeS: number | null;
  ledTemperatureC: number | null;
  ledVoltageV: number | null;
  ledCurrentA: number | null;
  raw: D4iRaw | null;
  recordedAt: string | null;
}

/** `d4i_periodic` payload'ının ham gövdesi (yalnızca okunan alanlar tiplenir). */
export interface D4iRaw {
  d4i?: {
    driver?: Record<string, number | null>;
    led?: Record<string, number | null>;
    energy?: { value?: number | null; unit?: string | null };
    power?: { value?: number | null; unit?: string | null };
  };
}

/** Bir ESP'ye bağlı tek bağımsız aydınlatma (DALI kanalı). */
export interface Fixture {
  id: string;
  deviceId: string; // MAC
  channel: number; // 0-63
  name: string | null;
  brightness: number; // 0-100
  isOn: boolean;
  activeFx: number | null;
  status: string; // ok | fault
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
