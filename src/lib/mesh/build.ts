/**
 * Mesh rota ağacı (saf; sunucu, istemci ve tsx betikleri kullanabilir).
 *
 * Kaynak: lamba health'indeki `thread.route_next_hop` (0xCE, BR'ye giden ilk
 * sıçramanın RLOC16'sı) ve `thread.route_path_cost` (0xCF, BR'ye toplam yol
 * maliyeti). Bunlardan cihaz → next hop → … → Border Router zinciri kurulur;
 * yük, trafik tahmini ve mesafe buradan türetilir. Yeni firmware alanı gerekmez.
 *
 * RLOC16 yalnızca bir Thread bölümü (partition) içinde tekildir: eşleşme aynı
 * partition'da yapılır (bir tarafta partition yoksa kabul edilir — gateway
 * topolojisindeki `toGatewayTopology` kuralıyla aynı).
 *
 * Test: npm run check:mesh
 */

/** Eşikler tek yerde (öneriler ve rozetler). */
export const THRESHOLDS = {
  /** Bu kadar (ve fazla) direğin trafiğini taşıyan router "darboğaz". */
  hotLoad: 5,
  /** Next hop'a link maliyeti bu ve üstü "zayıf link". */
  weakLinkCost: 3,
  /** Ara router önerisi: parent RSSI ort. bunun altında (dBm). */
  relayRssiDbm: -80,
  /** Ara router önerisi: 24 sa parent değişimi en az. */
  relayParentChanges: 3,
  /** Saha kontrolü: link maliyeti en az. */
  checkLinkCost: 2,
  /** Saha kontrolü: güncel RSSI, 24 sa ortalamasının bu kadar (dB) altında. */
  checkRssiDropDb: 5,
} as const;

/** Rapor/health aralığı bildirmeyen eski firmware ~30 sn'de bir gönderir. */
export const DEFAULT_INTERVAL_S = 30;
/** Yaklaşık paket boyları (binary v1): d4i_periodic ≤ 170 B, health ~120 B. */
export const D4I_PACKET_BYTES = 170;
export const HEALTH_PACKET_BYTES = 120;

/** "Rota yok" sentinel'leri (OpenThread geçersiz RLOC16 / sonsuz maliyet). */
const INVALID_RLOC = new Set([0xfffe, 0xffff]);
const INVALID_COST = 0xff;

export interface MeshDeviceInput {
  mac: string;
  name: string | null;
  poleId: string | null;
  poleCode: string | null;
  zoneSlug: string | null;
  lat: number | null;
  lng: number | null;
  online: boolean;
  healthAt: string | null;
  rloc16: number | null;
  partitionId: string | null;
  /** health.thread.role: child | router | leader | detached | disabled */
  role: string | null;
  nextHop: number | null;
  pathCost: number | null;
  parentRssiAvg: number | null;
  parentRssiLast: number | null;
  lqIn: number | null;
  lqOut: number | null;
  /** neighbors[] içinde next hop satırının link margin'i. */
  linkMargin: number | null;
  lampCount: number;
  reportIntervalS: number | null;
  healthIntervalS: number | null;
  /** Son 24 sa parent değişimi (sayaç farkı), geçmiş yoksa null. */
  parentChanges24h: number | null;
  /** Son 24 sa parent RSSI ortalaması. */
  rssiAvg24h: number | null;
}

export interface MeshGatewayInput {
  gatewayId: string;
  name: string | null;
  rloc16: number | null;
  partitionId: string | null;
  lat: number | null;
  lng: number | null;
  online: boolean;
  /** BR komşu tablosundan çerçeve hata oranları (yalnızca doğrudan komşular). */
  neighborErrors: { rloc16: number; frameErrorPct: number | null }[];
}

/**
 * routed: BR'ye ulaşan zincir · partial: zincir tanınmayan bir RLOC16'da biter ·
 * loop: döngü · no_route: cihaz rota yok bildiriyor · offline: bağlantısız ·
 * legacy: firmware 0xCE/0xCF göndermiyor.
 */
export type MeshStatus = "routed" | "partial" | "loop" | "no_route" | "offline" | "legacy";

export interface MeshLink {
  rssiAvg: number | null;
  rssiLast: number | null;
  lqIn: number | null;
  lqOut: number | null;
  linkMargin: number | null;
  frameErrorPct: number | null;
  parentChanges24h: number | null;
  rssiAvg24h: number | null;
}

export interface MeshNode {
  /** Cihaz: MAC · BR: `br:<GW_ID>` · tanınmayan: `rloc:<partition>:<hex>` */
  id: string;
  kind: "device" | "br" | "unknown";
  mac: string | null;
  gatewayId: string | null;
  /** Görünen ad: direk no → cihaz adı → MAC (BR: ad → "Border Router"). */
  label: string;
  poleId: string | null;
  zoneSlug: string | null;
  rloc16: number | null;
  partitionId: string | null;
  lat: number | null;
  lng: number | null;
  online: boolean;
  role: "router" | "child" | null;
  status: MeshStatus | null;
  nextHop: number | null;
  pathCost: number | null;
  parentId: string | null;
  /** Zincirin kökündeki BR (`br:<GW_ID>`), yoksa null. */
  rootId: string | null;
  hops: number | null;
  linkCost: number | null;
  children: string[];
  /** Trafiği bu düğümden geçen (alt ağaçtaki) cihazlar. */
  descendants: string[];
  load: number;
  /** Paket/dk (tahmini): kendi, aktardığı, toplam BR'ye giden. */
  ownPpm: number;
  fwdPpm: number;
  upPpm: number;
  /** Bayt/dk (tahmini), toplam. */
  upBytesPerMin: number;
  distanceM: number | null;
  link: MeshLink | null;
  hot: boolean;
  weak: boolean;
}

export interface MeshKpi {
  deviceCount: number;
  onlineCount: number;
  routerCount: number;
  routedCount: number;
  totalUpPpm: number;
  totalUpBytesPerMin: number;
  avgPathCost: number | null;
  farthestId: string | null;
  maxHops: number | null;
  hotIds: string[];
  parentChanges24h: number;
  topParentChangesId: string | null;
}

export interface MeshTopology {
  nodes: MeshNode[];
  kpi: MeshKpi;
}

export function hex16(v: number): string {
  return "0x" + v.toString(16).padStart(4, "0");
}

/** İki WGS84 noktası arası (m). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cihazın kendi uplink'i (paket/dk): armatür başına D4i raporu + health. */
export function ownTraffic(d: Pick<MeshDeviceInput, "lampCount" | "reportIntervalS" | "healthIntervalS">): {
  ppm: number;
  bytesPerMin: number;
} {
  const report = d.reportIntervalS && d.reportIntervalS > 0 ? d.reportIntervalS : DEFAULT_INTERVAL_S;
  const health = d.healthIntervalS && d.healthIntervalS > 0 ? d.healthIntervalS : DEFAULT_INTERVAL_S;
  const d4i = (Math.max(0, d.lampCount) * 60) / report;
  const h = 60 / health;
  return { ppm: d4i + h, bytesPerMin: d4i * D4I_PACKET_BYTES + h * HEALTH_PACKET_BYTES };
}

function partitionsMatch(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function deviceRole(role: string | null, rloc16: number | null): "router" | "child" | null {
  if (role === "router" || role === "leader") return "router";
  if (role === "child") return "child";
  if (rloc16 !== null) return (rloc16 & 0x1ff) === 0 ? "router" : "child";
  return null;
}

export function buildMeshTopology(devices: MeshDeviceInput[], gateways: MeshGatewayInput[]): MeshTopology {
  const nodes = new Map<string, MeshNode>();
  const ownBytes = new Map<string, number>();

  // ── Düğümler ──
  for (const g of gateways) {
    nodes.set(`br:${g.gatewayId}`, {
      id: `br:${g.gatewayId}`,
      kind: "br",
      mac: null,
      gatewayId: g.gatewayId,
      label: g.name || "Border Router",
      poleId: null,
      zoneSlug: null,
      rloc16: g.rloc16,
      partitionId: g.partitionId,
      lat: g.lat,
      lng: g.lng,
      online: g.online,
      role: "router",
      status: null,
      nextHop: null,
      pathCost: 0,
      parentId: null,
      rootId: `br:${g.gatewayId}`,
      hops: 0,
      linkCost: null,
      children: [],
      descendants: [],
      load: 0,
      ownPpm: 0,
      fwdPpm: 0,
      upPpm: 0,
      upBytesPerMin: 0,
      distanceM: null,
      link: null,
      hot: false,
      weak: false,
    });
  }
  const devInput = new Map<string, MeshDeviceInput>();
  for (const d of devices) {
    devInput.set(d.mac, d);
    const t = ownTraffic(d);
    ownBytes.set(d.mac, t.bytesPerMin);
    nodes.set(d.mac, {
      id: d.mac,
      kind: "device",
      mac: d.mac,
      gatewayId: null,
      label: d.poleCode || d.name || d.mac,
      poleId: d.poleId,
      zoneSlug: d.zoneSlug,
      rloc16: d.rloc16,
      partitionId: d.partitionId,
      lat: d.lat,
      lng: d.lng,
      online: d.online,
      role: deviceRole(d.role, d.rloc16),
      status: null,
      nextHop: d.nextHop,
      pathCost: d.pathCost,
      parentId: null,
      rootId: null,
      hops: null,
      linkCost: null,
      children: [],
      descendants: [],
      load: 0,
      ownPpm: t.ppm,
      fwdPpm: 0,
      upPpm: t.ppm,
      upBytesPerMin: t.bytesPerMin,
      distanceM: null,
      link: {
        rssiAvg: d.parentRssiAvg,
        rssiLast: d.parentRssiLast,
        lqIn: d.lqIn,
        lqOut: d.lqOut,
        linkMargin: d.linkMargin,
        frameErrorPct: null,
        parentChanges24h: d.parentChanges24h,
        rssiAvg24h: d.rssiAvg24h,
      },
      hot: false,
      weak: false,
    });
  }

  // ── RLOC16 çözümü: BR önce, sonra çevrimiçi ve en yeni health ──
  const byRloc = new Map<number, MeshNode[]>();
  for (const n of nodes.values()) {
    if (n.rloc16 === null) continue;
    const list = byRloc.get(n.rloc16) ?? [];
    list.push(n);
    byRloc.set(n.rloc16, list);
  }
  const healthTime = (n: MeshNode) => {
    const at = n.mac ? devInput.get(n.mac)?.healthAt : null;
    return at ? Date.parse(at) : 0;
  };
  for (const list of byRloc.values()) {
    list.sort(
      (a, b) =>
        Number(b.kind === "br") - Number(a.kind === "br") ||
        Number(b.online) - Number(a.online) ||
        healthTime(b) - healthTime(a),
    );
  }
  function resolve(rloc: number, partition: string | null, self: string): MeshNode {
    const hit = (byRloc.get(rloc) ?? []).find((n) => n.id !== self && partitionsMatch(n.partitionId, partition));
    if (hit) return hit;
    const id = `rloc:${partition ?? "?"}:${hex16(rloc)}`;
    let unknown = nodes.get(id);
    if (!unknown) {
      unknown = {
        id,
        kind: "unknown",
        mac: null,
        gatewayId: null,
        label: hex16(rloc),
        poleId: null,
        zoneSlug: null,
        rloc16: rloc,
        partitionId: partition,
        lat: null,
        lng: null,
        online: false,
        role: deviceRole(null, rloc),
        status: null,
        nextHop: null,
        pathCost: null,
        parentId: null,
        rootId: null,
        hops: null,
        linkCost: null,
        children: [],
        descendants: [],
        load: 0,
        ownPpm: 0,
        fwdPpm: 0,
        upPpm: 0,
        upBytesPerMin: 0,
        distanceM: null,
        link: null,
        hot: false,
        weak: false,
      };
      nodes.set(id, unknown);
    }
    return unknown;
  }

  // ── Ebeveynler ──
  for (const d of devices) {
    const n = nodes.get(d.mac)!;
    if (!d.online) {
      n.status = "offline";
      continue;
    }
    if (d.nextHop === null && d.pathCost === null) {
      n.status = "legacy";
      continue;
    }
    if (d.nextHop === null || INVALID_RLOC.has(d.nextHop) || d.pathCost === INVALID_COST) {
      n.status = "no_route";
      continue;
    }
    n.parentId = resolve(d.nextHop, d.partitionId, d.mac).id;
  }

  // ── Zincirler: kök, hop, döngü ──
  for (const n of nodes.values()) {
    if (n.kind !== "device" || n.parentId === null) continue;
    const seen = new Set<string>([n.id]);
    let cur = nodes.get(n.parentId)!;
    let hops = 1;
    let loop = false;
    while (cur.parentId !== null && cur.kind === "device") {
      if (seen.has(cur.id)) {
        loop = true;
        break;
      }
      seen.add(cur.id);
      cur = nodes.get(cur.parentId)!;
      hops++;
    }
    if (loop || seen.has(cur.id)) {
      n.status = "loop";
    } else if (cur.kind === "br") {
      n.status = "routed";
      n.rootId = cur.id;
      n.hops = hops;
    } else {
      // Tanınmayan RLOC16'da ya da rotasız/bağlantısız bir cihazda biten zincir.
      n.status = "partial";
    }
  }
  // Döngüdeki bağlar çizilmez, yük hesabına girmez.
  for (const n of nodes.values()) if (n.status === "loop") n.parentId = null;

  // ── Çocuklar, link maliyeti, mesafe ──
  for (const n of nodes.values()) {
    if (n.parentId === null) continue;
    const p = nodes.get(n.parentId)!;
    p.children.push(n.id);
    if (n.pathCost !== null && p.pathCost !== null) {
      const c = n.pathCost - p.pathCost;
      n.linkCost = c >= 0 ? c : null;
    }
    if (n.lat !== null && n.lng !== null && p.lat !== null && p.lng !== null) {
      n.distanceM = Math.round(distanceMeters({ lat: n.lat, lng: n.lng }, { lat: p.lat, lng: p.lng }));
    }
    // BR'ye doğrudan bağlı cihazda çerçeve hata oranı BR'nin komşu tablosundan.
    if (p.kind === "br" && n.link && n.rloc16 !== null) {
      const gw = gateways.find((g) => `br:${g.gatewayId}` === p.id);
      const nb = gw?.neighborErrors.find((e) => e.rloc16 === n.rloc16);
      if (nb) n.link.frameErrorPct = nb.frameErrorPct;
    }
  }

  // ── Alt ağaç: yük ve trafik (döngüler kırıldı, ağaç sonlu) ──
  const visit = (n: MeshNode): string[] => {
    const out: string[] = [];
    for (const cid of n.children) {
      const c = nodes.get(cid)!;
      out.push(cid, ...visit(c));
    }
    return out;
  };
  for (const n of nodes.values()) {
    n.descendants = visit(n).filter((id) => nodes.get(id)!.kind === "device");
    n.load = n.descendants.length;
    n.fwdPpm = n.descendants.reduce((s, id) => s + nodes.get(id)!.ownPpm, 0);
    n.upPpm = n.ownPpm + n.fwdPpm;
    n.upBytesPerMin =
      (n.mac ? (ownBytes.get(n.mac) ?? 0) : 0) +
      n.descendants.reduce((s, id) => s + (ownBytes.get(id) ?? 0), 0);
    n.hot = n.kind === "device" && n.load >= THRESHOLDS.hotLoad;
    n.weak = n.linkCost !== null && n.linkCost >= THRESHOLDS.weakLinkCost;
  }

  // ── Özet ──
  const devs = [...nodes.values()].filter((n) => n.kind === "device");
  const routed = devs.filter((n) => n.status === "routed");
  const costs = routed.map((n) => n.pathCost).filter((c): c is number => c !== null);
  const farthest = routed.reduce<MeshNode | null>((a, b) => (a === null || (b.hops ?? 0) > (a.hops ?? 0) ? b : a), null);
  let pcTotal = 0;
  let topPc: { id: string; n: number } | null = null;
  for (const d of devices) {
    const pc = d.parentChanges24h ?? 0;
    pcTotal += pc;
    if (pc > 0 && (!topPc || pc > topPc.n)) topPc = { id: d.mac, n: pc };
  }
  const kpi: MeshKpi = {
    deviceCount: devs.length,
    onlineCount: devs.filter((n) => n.online).length,
    routerCount: devs.filter((n) => n.online && n.role === "router").length,
    routedCount: routed.length,
    // Çevrimiçi her cihazın trafiği eninde sonunda bir BR'ye gider (rota bilinmese de).
    totalUpPpm: devs.filter((n) => n.online).reduce((s, n) => s + n.ownPpm, 0),
    totalUpBytesPerMin: devs.filter((n) => n.online).reduce((s, n) => s + (ownBytes.get(n.id) ?? 0), 0),
    avgPathCost: costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null,
    farthestId: farthest?.id ?? null,
    maxHops: farthest?.hops ?? null,
    hotIds: devs
      .filter((n) => n.hot)
      .sort((a, b) => b.load - a.load)
      .map((n) => n.id),
    parentChanges24h: pcTotal,
    topParentChangesId: topPc?.id ?? null,
  };

  return { nodes: [...nodes.values()], kpi };
}

/** Düğümden köke (BR ya da zincirin bittiği yer) yol: [düğüm, next hop, …]. */
export function pathToRoot(nodes: ReadonlyMap<string, MeshNode>, id: string): MeshNode[] {
  const out: MeshNode[] = [];
  const seen = new Set<string>();
  let cur = nodes.get(id);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return out;
}
