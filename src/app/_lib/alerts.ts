import type { DeviceView, OpenFault } from "./types";
import { describeDeviceError } from "@/lib/deviceErrors";
import { faultCategory, faultDescription, faultLabel, isWarningCode, type FaultCategory } from "@/lib/faults";

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
  /** Arızanın ait olduğu parça (lamba, sürücü, LED, bağlantı, komut). */
  category: FaultCategory;
  /** Işık hâlâ yanıyor (termal kısma, güç sınırlama) — arıza değil uyarı. */
  warning: boolean;
  title: string;
  /** Ne oluyor: lamba arızasında katalog açıklaması, komut hatasında sebep. */
  cause: string | null;
  deviceId: string;
  deviceName: string | null;
  zoneSlug: string | null;
  zoneName: string | null;
  channel: number | null;
  since: string | null;
}

/** `technical: false` → müşteri kullanıcılarına sade başlık/sebep (bkz. useTechnical). */
export function openAlerts(
  faults: OpenFault[],
  devices: DeviceView[],
  technical = true,
): AlertItem[] {
  const items: AlertItem[] = faults.map((f) => {
    const text = faultDescription(f.code, technical);
    return {
      key: `f:${f.deviceId}:${f.channel}:${f.code}`,
      kind: "fault",
      code: f.code,
      category: faultCategory(f.code),
      warning: isWarningCode(f.code),
      title: faultLabel(f.code, technical),
      cause: text?.what ?? null,
      deviceId: f.deviceId,
      deviceName: f.deviceName,
      zoneSlug: f.zoneSlug,
      zoneName: f.zoneName,
      channel: f.channel,
      since: f.startedAt,
    };
  });
  for (const d of devices) {
    if (!d.lastError) continue;
    const info = describeDeviceError(d.lastError, { technical });
    items.push({
      key: `c:${d.deviceId}`,
      kind: "command",
      code: null,
      category: "command",
      warning: false,
      title: info.title,
      cause: info.cause,
      deviceId: d.deviceId,
      deviceName: d.name,
      zoneSlug: d.zoneSlug,
      zoneName: d.zoneName,
      channel: null,
      since: d.lastErrorAt,
    });
  }
  return items;
}
