import type { ZoneRow } from "@/lib/db/schema";
import type { Zone, ZoneStatus, DeviceView } from "@/app/_lib/types";

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
  };
}
