import type {
  ZoneRow,
  FixtureRow,
  D4iTelemetryRow,
  FaultEventRow,
  UserRow,
  GatewayRow,
  PoleRow,
} from "@/lib/db/schema";
import { gatewayOnlineWindowMs, gatewayTypeLabel, summarizeGateway } from "@/lib/gateways";
import type { BrNeighbor, BrRoute } from "@/lib/binproto/brToJson";
import type { CustomerUser } from "@/types/admin";
import { deviceHealthSchema } from "@/types/lighting";
import type { CustomerRole } from "@/lib/auth/roles";
import { onlineWindowMs } from "@/lib/deviceWindows";
import type {
  Zone,
  ZoneStatus,
  DeviceView,
  Fixture,
  D4iSnapshot,
  D4iRaw,
  FaultEvent,
  GatewayTopology,
  GatewayView,
  PoleView,
  TopologyDevice,
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
  firmwareVersion?: string | null;
  health?: Record<string, unknown> | null;
  healthAt?: Date | null;
  healthIntervalS?: number | null;
  reportIntervalS?: number | null;
  gatewayId?: string | null;
  poleId?: string | null;
  poleCode?: string | null;
  lamps?: DeviceView["lamps"];
  groups?: string[];
  zoneSync?: DeviceView["zoneSync"];
  masterOn?: boolean | null;
  masterBrightness?: number | null;
}): DeviceView {
  // Ham health mesajından yalnızca panelin kullandığı alanlar (şema dışı
  // alanlar DB'de kalır).
  const health = row.health ? deviceHealthSchema.safeParse(row.health) : null;
  const h = health?.success ? health.data : null;
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
    firmwareVersion: row.firmwareVersion ?? null,
    resetReason: h?.reset_reason ?? null,
    ota: h?.ota ?? null,
    healthAt: row.healthAt ? row.healthAt.toISOString() : null,
    healthIntervalS: row.healthIntervalS ?? null,
    reportIntervalS: row.reportIntervalS ?? null,
    onlineWindowMs: onlineWindowMs({
      healthIntervalS: row.healthIntervalS ?? null,
      reportIntervalS: row.reportIntervalS ?? null,
    }),
    gatewayId: row.gatewayId ?? null,
    poleId: row.poleId ?? null,
    poleCode: row.poleCode ?? null,
    lamps: row.lamps ?? [],
    groups: row.groups ?? [],
    zoneSync: row.zoneSync ?? null,
    masterOn: row.masterOn ?? null,
    masterBrightness: row.masterBrightness ?? null,
  };
}

/** `poles` satırını (+ bölge, bağlı cihaz MAC'i) panel görünümüne çevirir. */
export function toPoleView(
  row: PoleRow & { zoneSlug: string; zoneName: string; deviceId: string | null },
): PoleView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    zoneSlug: row.zoneSlug,
    zoneName: row.zoneName,
    lat: row.lat,
    lng: row.lng,
    locationSource: row.locationSource,
    locationAccuracyM: row.locationAccuracyM,
    notes: row.notes,
    deviceId: row.deviceId,
  };
}

/**
 * `gateways` satırını (+ bölge, bağlı cihaz sayısı) panel görünümüne çevirir.
 * `technical`: admin teknik alanları ve ham mesajları görür; müşteri yalnızca
 * sade alanları (IP, SIM numarası gibi ayrıntılar ona gönderilmez).
 */
/** Müşterinin lambası, Thread kimliğiyle (topoloji satırlarını adlandırmak için). */
export type ThreadDevice = { mac: string; name: string | null; rloc16: number; partitionId: string | null };

function topologyBlock(v: unknown): { at: string | null; items: unknown[] } | null {
  if (typeof v !== "object" || v === null) return null;
  const b = v as { at?: unknown; items?: unknown };
  if (!Array.isArray(b.items)) return null;
  return { at: typeof b.at === "string" ? b.at : null, items: b.items };
}

/**
 * `gateways.report` (son topoloji turu) → panel görünümü. RLOC16 yalnızca
 * Thread bölümü (partition) içinde tekildir: lamba eşleşmesi gateway'le aynı
 * partition'daki lambalarla yapılır.
 */
function toGatewayTopology(
  report: Record<string, unknown> | null,
  health: Record<string, unknown> | null,
  devices: ThreadDevice[],
): GatewayTopology | undefined {
  if (!report) return undefined;
  const thread = (health?.thread ?? null) as Record<string, unknown> | null;
  const partition = typeof thread?.partition_id === "string" ? thread.partition_id : null;
  const selfRloc = typeof thread?.rloc16 === "number" ? thread.rloc16 : null;
  const byRloc = new Map<number, TopologyDevice>();
  for (const d of devices) {
    if (partition !== null && d.partitionId !== null && d.partitionId !== partition) continue;
    byRloc.set(d.rloc16, { mac: d.mac, name: d.name });
  }
  const nb = topologyBlock(report.neighbors);
  const rt = topologyBlock(report.routes);
  return {
    neighbors: nb
      ? {
          at: nb.at,
          items: (nb.items as BrNeighbor[]).map((n) => ({ ...n, device: byRloc.get(n.rloc16) ?? null })),
        }
      : null,
    routes: rt
      ? {
          at: rt.at,
          items: (rt.items as BrRoute[]).map((r) => ({
            ...r,
            device: r.rloc16 !== null ? (byRloc.get(r.rloc16) ?? null) : null,
            self: selfRloc !== null && r.rloc16 === selfRloc,
          })),
        }
      : null,
  };
}

export function toGatewayView(
  row: GatewayRow & { zoneSlug: string | null; zoneName: string | null; deviceCount: number },
  technical: boolean,
  threadDevices: ThreadDevice[] = [],
): GatewayView {
  const view: GatewayView = {
    id: row.id,
    gatewayId: row.gatewayId,
    type: row.type,
    typeLabel: gatewayTypeLabel(row.type, technical),
    name: row.name,
    zoneSlug: row.zoneSlug,
    zoneName: row.zoneName,
    location: row.location,
    notes: row.notes,
    firmwareVersion: row.firmwareVersion,
    lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
    online: row.online,
    onlineWindowMs: gatewayOnlineWindowMs(row.health),
    deviceCount: row.deviceCount,
    fields: summarizeGateway({ type: row.type, health: row.health }, { technical }),
  };
  if (technical) {
    view.topology = toGatewayTopology(row.report, row.health, threadDevices);
    view.raw = {
      health: row.health,
      healthAt: row.healthAt ? row.healthAt.toISOString() : null,
      report: row.report,
      reportAt: row.reportAt ? row.reportAt.toISOString() : null,
    };
  }
  return view;
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
