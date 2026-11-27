/** Ağ haritası API yanıt şekilleri (istemci + sunucu). */
import type { MeshKpi, MeshNode } from "./build";
import type { MeshEvent } from "./events";
import type { MeshSuggestion } from "./suggest";

export interface MeshSeries {
  /** ISO saat başları, eskiden yeniye (son 24 sa). */
  hours: string[];
  parentChanges: number[];
  avgPathCost: (number | null)[];
}

export interface MeshView {
  at: string;
  nodes: MeshNode[];
  kpi: MeshKpi;
  suggestions: MeshSuggestion[];
  events: MeshEvent[];
  series: MeshSeries;
}

export interface DeviceMeshView {
  at: string;
  node: MeshNode | null;
  /** [cihaz, next hop, …, BR] */
  path: Array<Pick<MeshNode, "id" | "kind" | "label" | "rloc16" | "pathCost" | "mac">>;
  neighbors: Array<{
    rloc16: number | null;
    label: string | null;
    mac: string | null;
    role: string | null;
    rssiAvg: number | null;
    linkMargin: number | null;
    lqIn: number | null;
    isNextHop: boolean;
  }>;
  /** Cihazın health'i 0xCE/0xCF taşıyor mu (eski firmware false). */
  routeSupported: boolean;
  series: { hours: string[]; rssiAvg: (number | null)[]; pathCost: (number | null)[] };
}
