/**
 * Mesh rota ağacı, öneriler ve ağ olayları (src/lib/mesh) saf kontrolü.
 * Sunucu/DB/broker gerekmez:  npm run check:mesh
 */
import {
  THRESHOLDS,
  buildMeshTopology,
  distanceMeters,
  ownTraffic,
  pathToRoot,
  type MeshDeviceInput,
  type MeshGatewayInput,
} from "../src/lib/mesh/build";
import { suggestMesh } from "../src/lib/mesh/suggest";
import { healthEvents, type HealthChangeRow } from "../src/lib/mesh/events";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const P = "305419896";
const base = { lat: 40.76, lng: 29.94 };
let seq = 0;
function dev(
  code: string,
  rloc16: number,
  nextHop: number | null,
  pathCost: number | null,
  extra: Partial<MeshDeviceInput> = {},
): MeshDeviceInput {
  seq++;
  return {
    mac: `MAC${code}`,
    name: null,
    poleId: `p${code}`,
    poleCode: `D-${code}`,
    zoneSlug: "park",
    lat: base.lat + seq * 0.0005,
    lng: base.lng,
    online: true,
    healthAt: "2026-11-27T10:00:00Z",
    rloc16,
    partitionId: P,
    role: (rloc16 & 0x1ff) === 0 ? "router" : "child",
    nextHop,
    pathCost,
    parentRssiAvg: -50,
    parentRssiLast: -50,
    lqIn: 3,
    lqOut: 3,
    linkMargin: 50,
    lampCount: 2,
    reportIntervalS: 60,
    healthIntervalS: 120,
    parentChanges24h: 0,
    rssiAvg24h: -50,
    ...extra,
  };
}
const gw: MeshGatewayInput = {
  gatewayId: "GW0001",
  name: "Pano",
  rloc16: 0x4800,
  partitionId: P,
  lat: base.lat,
  lng: base.lng,
  online: true,
  neighborErrors: [{ rloc16: 0x1c00, frameErrorPct: 0.4 }],
};

// Ağaç: 01 → BR, 04/05/07/18 → 01, 06/19 → 04, 08 → 07, 10 → 05
const devices = [
  dev("01", 0x1c00, 0x4800, 1),
  dev("04", 0x0400, 0x1c00, 2),
  dev("05", 0xc400, 0x1c00, 4, { parentRssiAvg: -83, parentChanges24h: 6, rssiAvg24h: -82 }),
  dev("07", 0x2c00, 0x1c00, 3),
  dev("18", 0x1c03, 0x1c00, 2),
  dev("06", 0x0401, 0x0400, 3),
  dev("19", 0x3000, 0x0400, 3),
  dev("08", 0x2c01, 0x2c00, 5, { parentRssiAvg: -71, rssiAvg24h: -64 }),
  dev("10", 0xc401, 0xc400, 5),
  // Eski firmware (0xCE/0xCF yok), rotasız, çevrimdışı, tanınmayan next hop, döngü
  dev("20", 0x2c03, null, null),
  dev("21", 0x2c04, 0xfffe, 0xff),
  dev("22", 0x8002, 0x1c00, 2, { online: false }),
  dev("23", 0x8003, 0x9999, 3),
  dev("30", 0xa400, 0xa800, 3),
  dev("31", 0xa800, 0xa400, 3),
  // Aynı RLOC16 başka partition'da: eşleşmemeli
  dev("40", 0x5000, 0x1c00, 2, { partitionId: "999" }),
];
const { nodes, kpi } = buildMeshTopology(devices, [gw]);
const by = new Map(nodes.map((n) => [n.id, n]));
const n = (code: string) => by.get(`MAC${code}`)!;

check("01 BR'ye doğrudan bağlı", n("01").parentId === "br:GW0001" && n("01").hops === 1 && n("01").status === "routed");
check("06 → 04 → 01 → BR, 3 hop", n("06").parentId === "MAC04" && n("06").hops === 3 && n("06").rootId === "br:GW0001");
check(
  "pathToRoot 10: 10, 05, 01, BR",
  pathToRoot(by, "MAC10").map((x) => x.id).join(",") === "MAC10,MAC05,MAC01,br:GW0001",
);
check("linkCost = path cost farkı (05: 4 − 1 = 3)", n("05").linkCost === 3 && n("05").weak);
check("linkCost BR'ye: 01 = 1", n("01").linkCost === 1);
check("01 yükü 8 direk (taşıdığı)", n("01").load === 8, String(n("01").load));
check("01 darboğaz (≥ 5)", n("01").hot && !n("04").hot);
check("BR yükü 8 + 01 = 9", by.get("br:GW0001")!.load === 9, String(by.get("br:GW0001")!.load));
const own = ownTraffic({ lampCount: 2, reportIntervalS: 60, healthIntervalS: 120 }).ppm;
check("kendi trafiği 2 armatür/60 sn + health/120 sn = 2,5 paket/dk", own === 2.5);
check("01 toplam = 9 × 2,5 paket/dk", Math.abs(n("01").upPpm - 9 * 2.5) < 1e-9, String(n("01").upPpm));
check("01 aktardığı = 8 × 2,5", Math.abs(n("01").fwdPpm - 8 * 2.5) < 1e-9);
check("eski firmware → legacy, kenar yok", n("20").status === "legacy" && n("20").parentId === null);
check("0xFFFE / 0xFF → no_route", n("21").status === "no_route" && n("21").parentId === null);
check("çevrimdışı → offline, kenar yok", n("22").status === "offline" && n("22").parentId === null);
check(
  "tanınmayan next hop → rloc: düğümü, partial",
  n("23").status === "partial" && n("23").parentId === `rloc:${P}:0x9999` && by.has(`rloc:${P}:0x9999`),
);
check("döngü → loop, bağ çizilmez", n("30").status === "loop" && n("31").status === "loop" && n("30").parentId === null);
check(
  "başka partition'daki RLOC16 eşleşmez",
  n("40").parentId !== "MAC01" && n("40").status === "partial",
  String(n("40").parentId),
);
check("BR komşu tablosundan çerçeve hata oranı (01)", n("01").link?.frameErrorPct === 0.4);
check("BR'ye doğrudan bağlı olmayanda çerçeve hata yok", n("04").link?.frameErrorPct === null);
check("mesafe metre (haversine)", n("01").distanceM === Math.round(distanceMeters(n("01") as never, gw as never)));
check("KPI: en uzak 3 hop", kpi.maxHops === 3, String(kpi.maxHops));
check("KPI: darboğaz yalnızca 01", kpi.hotIds.join(",") === "MAC01");
check("KPI: parent değişimi toplam 6, en çok 05", kpi.parentChanges24h === 6 && kpi.topParentChangesId === "MAC05");
check(
  "KPI: ortalama yol maliyeti (yalnızca routed)",
  kpi.avgPathCost !== null && Math.abs(kpi.avgPathCost - (1 + 2 + 4 + 3 + 2 + 3 + 3 + 5 + 5) / 9) < 1e-9,
  String(kpi.avgPathCost),
);
check("KPI: çevrimiçi 15 / 16", kpi.onlineCount === 15 && kpi.deviceCount === 16);

// Aynı RLOC16 iki cihazda: çevrimiçi ve en yeni health kazanır.
{
  const dup = [
    dev("A", 0x6400, 0x4800, 1, { healthAt: "2026-11-27T09:00:00Z" }),
    dev("B", 0x6400, 0x4800, 1, { healthAt: "2026-11-27T10:00:00Z" }),
    dev("C", 0x6401, 0x6400, 2),
  ];
  const t = buildMeshTopology(dup, [gw]);
  const c = t.nodes.find((x) => x.id === "MACC")!;
  check("çift RLOC16: en yeni health'li cihaz seçilir", c.parentId === "MACB", String(c.parentId));
}

// ── Öneriler ──
const sugg = suggestMesh(nodes);
const kinds = sugg.map((s) => `${s.kind}:${s.focus[0]}`);
check("darboğaz 01 → 2. BR önerisi", kinds.includes("br:MAC01"), kinds.join(" "));
check("zayıf + kararsız 05 → ara router", kinds.includes("router:MAC05"), kinds.join(" "));
check("RSSI düşüşü 08 → saha kontrolü", kinds.includes("check:MAC08"), kinds.join(" "));
check("sağlıklı 06'ya öneri yok", !sugg.some((s) => s.focus[0] === "MAC06"));
const br = sugg.find((s) => s.kind === "br")!;
check(
  "2. BR: en büyük dal (04 + 06 + 19) taşınır, yük 8 → 5",
  br.compare[0][1] === "8" && br.compare[0][2] === "5",
  JSON.stringify(br.compare[0]),
);
check("öneri noktası konumlu", sugg.every((s) => s.point !== null));
check("eşikler tek yerde", THRESHOLDS.hotLoad === 5 && THRESHOLDS.weakLinkCost === 3);

// İç içe darboğaz: alttaki, üstteki önerinin dalındaysa ayrıca önerilmez.
{
  const chain = [
    dev("R", 0x1000, 0x4800, 1),
    dev("A", 0x1400, 0x1000, 2),
    ...["a1", "a2", "a3", "a4", "a5", "a6"].map((c, i) => dev(c, 0x1401 + i, 0x1400, 3)),
  ];
  const t = buildMeshTopology(chain, [gw]);
  const s = suggestMesh(t.nodes).filter((x) => x.kind === "br");
  check(
    "iç içe darboğaz (R 7, A 6) → tek 2. BR önerisi",
    s.length === 1 && s[0].focus[0] === "MACR",
    s.map((x) => x.focus[0]).join(","),
  );
}

// ── Olaylar ──
const rows: HealthChangeRow[] = [
  {
    mac: "MAC05", at: "2026-11-27T10:20:51Z", nextHop: 0x1c00, prevNextHop: 0x0400,
    pathCost: 4, prevPathCost: 4, parentChanges: 10, prevParentChanges: 9,
    rssi: -83, prevRssi: -82, partition: P, prevPartition: P,
  },
  {
    mac: "MAC08", at: "2026-11-27T10:18:07Z", nextHop: 0x2c00, prevNextHop: 0x2c00,
    pathCost: 5, prevPathCost: 5, parentChanges: 2, prevParentChanges: 2,
    rssi: -71, prevRssi: -64, partition: P, prevPartition: P,
  },
  {
    mac: "MAC05", at: "2026-11-27T10:02:33Z", nextHop: 0x1c00, prevNextHop: 0x1c00,
    pathCost: 4, prevPathCost: 2, parentChanges: 9, prevParentChanges: 9,
    rssi: -83, prevRssi: -83, partition: P, prevPartition: P,
  },
  {
    mac: "MAC06", at: "2026-11-27T09:00:00Z", nextHop: 0x0400, prevNextHop: 0x0400,
    pathCost: 3, prevPathCost: 3, parentChanges: 0, prevParentChanges: 7,
    rssi: -50, prevRssi: -50, partition: P, prevPartition: P,
  },
];
const names = new Map([[0x0400, "D-04"], [0x1c00, "D-01"]]);
const ev = healthEvents(rows, (r) => names.get(r) ?? `0x${r.toString(16)}`, new Map([["MAC05", 6]]));
check(
  "parent + next hop değişimi tek olay, kritik",
  ev[0].text === "Parent değişti: D-04 → D-01 (6 kez / 24 sa)" && ev[0].severity === "bad" && ev[0].source === "0xCB · 0xCE",
  ev[0]?.text,
);
check("RSSI düşüşü uyarı", ev.some((e) => e.nodeId === "MAC08" && e.source === "0xC2" && e.severity === "mid"));
check("yol maliyeti +2 → kritik", ev.some((e) => e.text === "Yol maliyeti 2 → 4" && e.severity === "bad"));
check("sayaç sıfırlanması olay değil", !ev.some((e) => e.nodeId === "MAC06"));
check("yeniden eskiye sıralı", ev.every((e, i) => i === 0 || ev[i - 1].at >= e.at));

console.log(failures ? `\n${failures} kontrol başarısız` : "\nHepsi geçti");
process.exit(failures ? 1 : 0);
