/**
 * Ağ haritası önerileri (saf). Kurallar mevcut health alanlarından çalışır;
 * yeni firmware alanı gerekmez. Metinler yalnızca admin'e gider (teknik dil).
 *
 * 1. 2. border router — router `load ≥ hotLoad` (darboğaz)
 * 2. Ara router       — link ≥ +3 VE parent RSSI ort. < −80 dBm VE 24 sa parent değişimi ≥ 3
 * 3. Saha kontrolü    — link ≥ +2 VE güncel RSSI, 24 sa ortalamasının ≥ 5 dB altında
 */
import { THRESHOLDS, type MeshNode } from "./build";

export type SuggestionKind = "br" | "router" | "check";

export interface MeshSuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  short: string;
  why: string;
  steps: string[];
  /** [ölçü, şimdi, sonra (tahmini)] */
  compare: Array<[string, string, string]>;
  rule: string;
  /** İlgili düğümler (ilki öneriye konu olan direk). */
  focus: string[];
  /** Öneri noktası (haritada); konum bilinmiyorsa null. */
  point: { lat: number; lng: number } | null;
  /** Öneri noktasından çizilecek kesikli bağlar (düğüm id'leri). */
  links: string[];
}

const fmt = (v: number, d = 1) =>
  v.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });

function located(n: MeshNode | undefined): n is MeshNode & { lat: number; lng: number } {
  return !!n && n.lat !== null && n.lng !== null;
}

function centroid(nodes: MeshNode[]): { lat: number; lng: number } | null {
  const pts = nodes.filter(located);
  if (pts.length === 0) return null;
  return {
    lat: pts.reduce((s, n) => s + n.lat, 0) / pts.length,
    lng: pts.reduce((s, n) => s + n.lng, 0) / pts.length,
  };
}

export function suggestMesh(nodeList: MeshNode[]): MeshSuggestion[] {
  const nodes = new Map(nodeList.map((n) => [n.id, n]));
  const out: MeshSuggestion[] = [];
  const taken = new Set<string>();

  // 1. Darboğaz → en büyük alt dalına yakın ikinci BR.
  const hot = nodeList.filter((n) => n.kind === "device" && n.hot).sort((a, b) => b.load - a.load);
  // Önerilen bir dalın içindeki darboğaz ayrıca önerilmez (yeni BR onu da rahatlatır).
  const covered = new Set<string>();
  for (const n of hot) {
    if (covered.has(n.id)) continue;
    const branches = n.children
      .map((id) => nodes.get(id)!)
      .filter((c) => c.kind === "device")
      .map((c) => ({ head: c, members: [c, ...c.descendants.map((id) => nodes.get(id)!)] }))
      .sort((a, b) => b.members.length - a.members.length);
    const branch = branches[0];
    if (!branch) continue;
    const moved = branch.members.length;
    const movedPpm = branch.members.reduce((s, m) => s + m.ownPpm, 0);
    const far = branch.members.reduce((a, b) => ((b.hops ?? 0) > (a.hops ?? 0) ? b : a), branch.head);
    const afterHops = far.hops !== null && n.hops !== null ? Math.max(1, far.hops - n.hops) : null;
    out.push({
      id: `oneri-br-${n.id}`,
      kind: "br",
      title: `${branch.head.label} yakınına ikinci border router`,
      short: `${n.label} yükü ${n.load} → ${n.load - moved} direğe iner`,
      why:
        `${n.label} ${n.load} direğin trafiğini taşıyor (≈${fmt(n.upPpm)} paket/dk). ` +
        `${n.label} düşerse ${branch.head.label} ve arkasındaki ${moved - 1} direk yeni yol arar.`,
      steps: [
        "Dalın yakınında enerji ve internet hattı olan bir noktaya ikinci border router koy (aynı Thread ağı, aynı dataset).",
        `${branch.head.label} ve arkasındaki ${moved - 1} direk en yakın BR olarak bunu seçer.`,
        `Bu taraf tek bir direğe (${n.label}) bağlı kalmaz.`,
      ],
      compare: [
        [`${n.label} taşıdığı`, String(n.load), String(n.load - moved)],
        [`${n.label} yükü (paket/dk)`, fmt(n.upPpm), fmt(n.upPpm - movedPpm)],
        ...(far.hops !== null && afterHops !== null
          ? ([[`${far.label} hop`, String(far.hops), String(afterHops)]] as Array<[string, string, string]>)
          : []),
      ],
      rule: `taşıdığı ≥ ${THRESHOLDS.hotLoad} direk → en büyük dalın yakınına 2. BR öner (yer: enerji + internet olan nokta)`,
      focus: [n.id, ...branch.members.map((m) => m.id)],
      point: centroid(branch.members),
      links: [branch.head.id],
    });
    taken.add(n.id);
    for (const m of branch.members) covered.add(m.id);
  }

  // 2. Zayıf ve kararsız link → ara router.
  for (const n of nodeList) {
    if (n.kind !== "device" || !n.link || n.parentId === null) continue;
    const { rssiAvg, parentChanges24h } = n.link;
    if (
      n.linkCost === null ||
      n.linkCost < THRESHOLDS.weakLinkCost ||
      rssiAvg === null ||
      rssiAvg >= THRESHOLDS.relayRssiDbm ||
      parentChanges24h === null ||
      parentChanges24h < THRESHOLDS.relayParentChanges
    ) {
      continue;
    }
    const p = nodes.get(n.parentId)!;
    const point = located(n) && located(p) ? { lat: (n.lat + p.lat) / 2, lng: (n.lng + p.lng) / 2 } : null;
    const behind = n.descendants.map((id) => nodes.get(id)!.label);
    out.push({
      id: `oneri-ara-${n.id}`,
      kind: "router",
      title: `${n.label} için ara router`,
      short: `zayıf link +${n.linkCost} → tahmini +1`,
      why:
        `${n.label}, ${p.label}'e ${n.distanceM !== null ? `${n.distanceM} m uzakta` : "bağlı"}. ` +
        `RSSI ort. ${rssiAvg} dBm` +
        (n.link.linkMargin !== null ? `, link margin ${n.link.linkMargin} dB` : "") +
        `. Son 24 saatte ${parentChanges24h} kez parent değiştirdi.` +
        (behind.length ? ` Arkasında ${behind.join(", ")} var.` : ""),
      steps: [
        `${n.label} ile ${p.label} arasına router rolünde bir direk ya da repeater ekle.`,
        `Ya da ${n.label}'in antenini/montajını ${p.label} yönüne göre kontrol et.`,
      ],
      compare: [
        [`${n.label} link`, `+${n.linkCost}`, "+1"],
        ...(n.pathCost !== null
          ? ([[`${n.label} yol maliyeti`, String(n.pathCost), String(Math.max(1, n.pathCost - (n.linkCost - 1)))]] as Array<
              [string, string, string]
            >)
          : []),
        ["Parent değişimi / 24 sa", String(parentChanges24h), "≤ 1"],
      ],
      rule:
        `link ≥ +${THRESHOLDS.weakLinkCost} VE RSSI < ${THRESHOLDS.relayRssiDbm} dBm VE ` +
        `parent değişimi ≥ ${THRESHOLDS.relayParentChanges} → ara router öner`,
      focus: [n.id, p.id, ...n.descendants],
      point,
      links: [n.id, p.id],
    });
    taken.add(n.id);
  }

  // 3. RSSI düşüşü → saha kontrolü.
  for (const n of nodeList) {
    if (n.kind !== "device" || !n.link || n.parentId === null || taken.has(n.id)) continue;
    const { rssiAvg, rssiAvg24h } = n.link;
    if (
      n.linkCost === null ||
      n.linkCost < THRESHOLDS.checkLinkCost ||
      rssiAvg === null ||
      rssiAvg24h === null ||
      rssiAvg > rssiAvg24h - THRESHOLDS.checkRssiDropDb
    ) {
      continue;
    }
    const p = nodes.get(n.parentId)!;
    const drop = Math.round(rssiAvg24h - rssiAvg);
    out.push({
      id: `oneri-kontrol-${n.id}`,
      kind: "check",
      title: `${n.label} montaj / anten kontrolü`,
      short: `RSSI 24 sa ortalamasından ${drop} dB düşük`,
      why:
        `${n.label} ile ${p.label} arası` +
        (n.distanceM !== null ? ` ${n.distanceM} m` : "") +
        `, link +${n.linkCost}. RSSI ${rssiAvg} dBm (24 sa ort. ${Math.round(rssiAvg24h)})` +
        (n.link.frameErrorPct !== null ? `, çerçeve hata %${fmt(n.link.frameErrorPct)}` : "") +
        (n.link.parentChanges24h ? `, ${n.link.parentChanges24h} parent değişimi` : "") +
        "." +
        (n.descendants.length
          ? ` Arkasında ${n.descendants.map((id) => nodes.get(id)!.label).join(", ")} var.`
          : ""),
      steps: [
        "Direkte anten, kutu kapağı ve nem kontrolü yap.",
        "Kontrolden sonra 24 saat RSSI'yi ve parent değişimini izle.",
      ],
      compare: [["RSSI", `${rssiAvg} dBm`, `≈ ${Math.round(rssiAvg24h)} dBm`]],
      rule:
        `link ≥ +${THRESHOLDS.checkLinkCost} VE RSSI 24 sa ort.'dan ≥ ${THRESHOLDS.checkRssiDropDb} dB düşük → saha kontrolü öner`,
      focus: [n.id, p.id, ...n.descendants],
      // Direğin hemen kuzeyi (~28 m): işaret direğin üstüne binmesin.
      point: located(n) ? { lat: n.lat + 0.00025, lng: n.lng } : null,
      links: [n.id],
    });
  }

  return out;
}
