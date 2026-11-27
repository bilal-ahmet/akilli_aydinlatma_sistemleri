/**
 * Ağ olayları (saf): ardışık iki health kaydının Thread alanlarındaki
 * değişimlerden üretilir. Satırlar sunucuda SQL `LAG()` ile yalnızca değişim
 * olan kayıtlar olarak gelir (lib/mesh/query.ts); burada metne çevrilir.
 */
import { THRESHOLDS } from "./build";

export type MeshEventSeverity = "bad" | "mid" | "info";

export interface HealthChangeRow {
  mac: string;
  at: string;
  nextHop: number | null;
  prevNextHop: number | null;
  pathCost: number | null;
  prevPathCost: number | null;
  parentChanges: number | null;
  prevParentChanges: number | null;
  rssi: number | null;
  prevRssi: number | null;
  partition: string | null;
  prevPartition: string | null;
}

export interface MeshEvent {
  at: string;
  severity: MeshEventSeverity;
  /** Olayın ait olduğu düğüm (cihaz MAC'i). */
  nodeId: string;
  text: string;
  /** Kaynak alan kod(lar)ı, ör. "0xCB · 0xCE". */
  source: string;
}

/** RLOC16 → görünen ad (bugünkü eşleşmeyle; geçmişteki RLOC başka direğe ait olabilir). */
export type RlocNamer = (rloc: number, partition: string | null) => string;

/**
 * `changes24h`: cihazın son 24 sa parent değişimi (önem derecesi için).
 * Sayaç sıfırlanması (yeniden başlatma, değer azalır) olay sayılmaz.
 */
export function healthEvents(
  rows: readonly HealthChangeRow[],
  nameOf: RlocNamer,
  changes24h: ReadonlyMap<string, number> = new Map(),
): MeshEvent[] {
  const out: MeshEvent[] = [];
  for (const r of rows) {
    const hopChanged = r.nextHop !== null && r.prevNextHop !== null && r.nextHop !== r.prevNextHop;
    const pcDelta =
      r.parentChanges !== null && r.prevParentChanges !== null ? r.parentChanges - r.prevParentChanges : 0;
    const name = (rloc: number) => nameOf(rloc, r.partition);

    if (r.partition !== null && r.prevPartition !== null && r.partition !== r.prevPartition) {
      out.push({
        at: r.at,
        severity: "bad",
        nodeId: r.mac,
        text: `Partition değişti: ${r.prevPartition} → ${r.partition}`,
        source: "0xC7",
      });
    }

    if (pcDelta > 0) {
      const n24 = changes24h.get(r.mac) ?? pcDelta;
      const tail = ` (${n24} kez / 24 sa)`;
      out.push({
        at: r.at,
        severity: n24 >= THRESHOLDS.relayParentChanges ? "bad" : "mid",
        nodeId: r.mac,
        text: hopChanged
          ? `Parent değişti: ${name(r.prevNextHop!)} → ${name(r.nextHop!)}${tail}`
          : `Parent değişti${tail}`,
        source: hopChanged ? "0xCB · 0xCE" : "0xCB",
      });
    } else if (hopChanged) {
      out.push({
        at: r.at,
        severity: "mid",
        nodeId: r.mac,
        text: `Next hop değişti: ${name(r.prevNextHop!)} → ${name(r.nextHop!)}`,
        source: "0xCE",
      });
    }

    if (r.pathCost !== null && r.prevPathCost !== null && r.pathCost !== r.prevPathCost) {
      const up = r.pathCost > r.prevPathCost;
      out.push({
        at: r.at,
        severity: up ? (r.pathCost - r.prevPathCost >= 2 ? "bad" : "mid") : "info",
        nodeId: r.mac,
        text: `Yol maliyeti ${r.prevPathCost} → ${r.pathCost}`,
        source: "0xCF",
      });
    }

    if (r.rssi !== null && r.prevRssi !== null && r.prevRssi - r.rssi >= THRESHOLDS.checkRssiDropDb) {
      out.push({
        at: r.at,
        severity: "mid",
        nodeId: r.mac,
        text: `RSSI düştü: ${r.prevRssi} → ${r.rssi} dBm`,
        source: "0xC2",
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

