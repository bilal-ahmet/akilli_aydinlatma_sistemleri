import type {
  ZoneRow,
  FixtureRow,
  D4iTelemetryRow,
  FaultEventRow,
  UserRow,
} from "@/lib/db/schema";
import type { CustomerUser } from "@/types/admin";
import type { CustomerRole } from "@/lib/auth/roles";
import type {
  Zone,
  ZoneStatus,
  DeviceView,
  Fixture,
  D4iSnapshot,
  D4iRaw,
  FaultEvent,
} from "@/app/_lib/types";

/**
 * DB `zones` satırını frontend `Zone` tipine çevirir. Frontend stabil public
 * id olarak `slug` kullanır (MQTT topic'leri ile aynı).
 */
export function toZone(row: ZoneRow): Zone {
  return {
    id: row.slug,
    name: row.name,
    district: row.district ?? "",
    poleCount: row.poleCount,
    isOn: row.isOn,
    brightness: row.brightness,
    status: (row.status as ZoneStatus) ?? "ok",
    activeFx: row.activeFx ?? null,
  };
}

/** Devices + zone join satırını (+ son telemetri) frontend görünümüne çevirir. */
export function toDeviceView(row: {
  id: string;
  deviceId: string;
  name: string | null;
  lastSeen: Date | null;
  zoneSlug: string | null;
  zoneName: string | null;
  brightness?: number | null;
  relayStatus?: string | null;
  temperature?: number | null;
  rssi?: number | null;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  lampCount?: number;
  activeFx?: number | null;
}): DeviceView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    zoneSlug: row.zoneSlug,
    zoneName: row.zoneName,
    name: row.name,
    lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
    brightness: row.brightness ?? null,
    relayStatus: row.relayStatus ?? null,
    temperature: row.temperature ?? null,
    rssi: row.rssi ?? null,
    lastError: row.lastError ?? null,
    lastErrorAt: row.lastErrorAt ? row.lastErrorAt.toISOString() : null,
    lampCount: row.lampCount ?? 0,
    activeFx: row.activeFx ?? null,
  };
}

/** DB `d4i_telemetry` satırını cihaz modalindeki detay görünümüne çevirir. */
export function toD4iSnapshot(row: D4iTelemetryRow): D4iSnapshot {
  return {
    channel: row.channel,
    online: row.online,
    d4iSupported: row.d4iSupported,
    actualLevel: row.actualLevel,
    minLevel: row.minLevel,
    maxLevel: row.maxLevel,
    physicalMinLevel: row.physicalMinLevel,
    lampFailure: row.lampFailure,
    lampPowerOn: row.lampPowerOn,
    controlGearPresent: row.controlGearPresent,
    energyWh: row.energyWh,
    powerW: row.powerW,
    driverTemperatureC: row.driverTemperatureC,
    driverVoltageV: row.driverVoltageV,
    driverOperatingTimeS: row.driverOperatingTimeS,
    ledTemperatureC: row.ledTemperatureC,
    ledVoltageV: row.ledVoltageV,
    ledCurrentA: row.ledCurrentA,
    raw: (row.raw as D4iRaw | null) ?? null,
    recordedAt: row.recordedAt ? row.recordedAt.toISOString() : null,
  };
}

/** DB `fixtures` satırını frontend `Fixture` tipine çevirir. */
export function toFixture(row: FixtureRow): Fixture {
  return {
    id: row.id,
    deviceId: row.deviceId,
    channel: row.channel,
    name: row.name,
    brightness: row.brightness,
    isOn: row.isOn,
    activeFx: row.activeFx ?? null,
    status: row.status,
    lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
  };
}

/** DB `fault_events` satırını frontend `FaultEvent` tipine çevirir. */
export function toFaultEvent(row: FaultEventRow): FaultEvent {
  return {
    id: row.id,
    channel: row.channel,
    code: row.code,
    detail: row.detail,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** DB `users` satırını müşteri kullanıcı listesi görünümüne çevirir (şifre özeti ASLA çıkmaz). */
export function toCustomerUser(u: UserRow): CustomerUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role as CustomerRole,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt ? u.createdAt.toISOString() : null,
  };
}
