import type { DeviceView, OpenFault } from "./types";
import { describeDeviceError } from "@/lib/deviceErrors";
import { faultLabel } from "@/lib/faults";

/**
 * Panelde "açık" sayılan her sorun: süren lamba arızaları (`fault_events`,
 * /api/faults) + son komutu hatayla dönen cihazlar (`devices.last_error`).
 * Kenar çubuğu rozeti, Genel Bakış kartı ve Arızalar sayfası aynı listeyi
 * sayar — sayılar ekranlar arasında tutarlı kalsın diye tek yerde.
 */
export interface AlertItem {
  key: string;
  kind: "fault" | "command";
  /** `fault_events.code` (lamba arızası) ya da null (komut hatası). */
  code: string | null;
  title: string;
  /** Komut hatasında sebep metni (katalogdan). */
  cause: string | null;
  deviceId: string;
  deviceName: string | null;
  zoneName: string | null;
  channel: number | null;
  since: string | null;
}

export function openAlerts(faults: OpenFault[], devices: DeviceView[]): AlertItem[] {
  const items: AlertItem[] = faults.map((f) => ({
    key: `f:${f.deviceId}:${f.channel}:${f.code}`,
    kind: "fault",
    code: f.code,
    title: faultLabel(f.code),
    cause: null,
    deviceId: f.deviceId,
    deviceName: f.deviceName,
    zoneName: f.zoneName,
    channel: f.channel,
    since: f.startedAt,
  }));
  for (const d of devices) {
    if (!d.lastError) continue;
    const info = describeDeviceError(d.lastError);
    items.push({
      key: `c:${d.deviceId}`,
      kind: "command",
      code: null,
      title: info.title,
      cause: info.cause,
      deviceId: d.deviceId,
      deviceName: d.name,
      zoneName: d.zoneName,
      channel: null,
      since: d.lastErrorAt,
    });
  }
  return items;
}
