"use client";

import { useMemo } from "react";
import type { DeviceMeasure, DeviceView } from "./types";
import { aggregateMeasures } from "./deviceHealth";
import { useLighting } from "./lighting";

export interface ZoneStats {
  devices: DeviceView[];
  /** Bölgedeki cihazların ölçüm toplamı (son 10 dk'da rapor verenler). */
  measure: DeviceMeasure;
}

const EMPTY: ZoneStats = { devices: [], measure: aggregateMeasures([]) };

/** Bölge slug'ı → cihazları + ölçüm toplamı. Bilinmeyen bölge için boş değer. */
export function useZoneStats(): (zoneId: string) => ZoneStats {
  const { devices, live } = useLighting();
  const map = useMemo(() => {
    const byZone = new Map<string, DeviceView[]>();
    for (const d of devices) {
      if (!d.zoneSlug) continue;
      const arr = byZone.get(d.zoneSlug);
      if (arr) arr.push(d);
      else byZone.set(d.zoneSlug, [d]);
    }
    const out = new Map<string, ZoneStats>();
    for (const [zoneId, ds] of byZone) {
      out.set(zoneId, {
        devices: ds,
        measure: aggregateMeasures(ds.map((d) => live?.devices?.[d.deviceId])),
      });
    }
    return out;
  }, [devices, live]);
  return (zoneId) => map.get(zoneId) ?? EMPTY;
}
