"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeshNode } from "@/lib/mesh/build";
import type { MeshView as MeshData } from "@/lib/mesh/view";
import { useLighting } from "@/app/_lib/lighting";
import { useApi } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { useReconcile } from "@/app/_lib/useReconcile";
import { lampOn } from "@/app/_lib/selection";
import { MESH_COLORS, type LatLng, type MeshOverlay, type OverlayLink, type OverlayNode } from "@/app/_lib/meshOverlay";
import { placePopover, type PopPlacement } from "@/app/_lib/popoverPlace";
import { useDialogs } from "../PanelDialogs";
import { PageHeader } from "../PanelUi";
import { useTheme } from "../ThemeProvider";
import { MeshPanel } from "../mesh/MeshPanel";
import { NodeTag, Sparkline, clockText, fmt, rlocText } from "../mesh/meshUi";

// WebGL: yalnız istemcide yüklenir.
const PoleMap = dynamic(() => import("../PoleMap").then((m) => m.PoleMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Harita yükleniyor…</div>,
});

/**
 * Ağ haritası (YALNIZCA ADMIN): direkler gerçek harita üzerinde, Thread mesh
 * rotaları lamba health'indeki 0xCE (next hop) / 0xCF (yol maliyeti)
 * alanlarından çizilir. Direğe tıklayınca BR'ye giden yol vurgulanır, yan
 * panelde taşıdığı yük ve link alanları, "Cihaza git" ile cihaz modalı.
 * Veri: `GET /api/mesh` (60 sn'de bir + sekme öne gelince).
 */

type ColorMode = "link" | "load";
type Layers = { routes: boolean; flow: boolean; sugg: boolean; glow: boolean };

const REFRESH_MS = 60_000;
const SEV: Record<string, { label: string; cls: string; dot: string }> = {
  bad: { label: "Kritik", cls: "text-danger", dot: "bg-danger" },
  mid: { label: "Uyarı", cls: "text-warn", dot: "bg-warn" },
  info: { label: "Bilgi", cls: "text-muted", dot: "bg-muted" },
};
const SUGG_TAG = { br: "öneri: 2. border router", router: "öneri: ara router", check: "öneri: saha kontrolü" } as const;
const POP_W = 250;

const located = (n: { lat: number | null; lng: number | null }): n is { lat: number; lng: number } =>
  n.lat !== null && n.lng !== null;

export function MeshView() {
  const api = useApi();
  const now = useNow(15_000);
  const { devices, live } = useLighting();
  const { openDevice } = useDialogs();
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const palette = dark ? MESH_COLORS.dark : MESH_COLORS.light;

  const [mesh, setMesh] = useState<MeshData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("link");
  const [layers, setLayers] = useState<Layers>({ routes: true, flow: true, sugg: true, glow: false });
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popId, setPopId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [placingBr, setPlacingBr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [fitKey, setFitKey] = useState("ilk");

  // Projeksiyon: harita kaydıkça kartın yeri yeniden hesaplanır.
  const projectRef = useRef<((p: LatLng) => { x: number; y: number } | null) | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const tickRaf = useRef(0);
  const mapBox = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    return fetch(api("/api/mesh"), { cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.data) throw new Error(j?.error ?? `Ağ haritası okunamadı (${res.status})`);
        setMesh(j.data as MeshData);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Ağ haritası okunamadı"));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load, REFRESH_MS);

  const byId = useMemo(() => new Map((mesh?.nodes ?? []).map((n) => [n.id, n])), [mesh]);
  const devByMac = useMemo(() => new Map(devices.map((d) => [d.deviceId, d])), [devices]);
  const maxUp = useMemo(
    () => Math.max(1, ...(mesh?.nodes ?? []).filter((n) => n.kind === "device").map((n) => n.upPpm)),
    [mesh],
  );

  // Seçim → vurgulanacak düğümler (yol + ilgili öneriler).
  const focus = useMemo(() => {
    if (!mesh || !selectedId) return null;
    const ids = new Set<string>();
    const addPath = (id: string) => {
      const seen = new Set<string>();
      for (let c = byId.get(id); c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
        seen.add(c.id);
        ids.add(c.id);
      }
    };
    const s = mesh.suggestions.find((x) => x.id === selectedId);
    if (s) {
      ids.add(s.id);
      for (const f of s.focus) addPath(f);
      return ids;
    }
    const n = byId.get(selectedId);
    if (!n || n.kind === "br") return null;
    addPath(n.id);
    for (const x of mesh.suggestions) if (x.focus.includes(n.id)) ids.add(x.id);
    return ids;
  }, [mesh, selectedId, byId]);

  const pickBr = useCallback(
    async (pos: LatLng) => {
      const gw = placingBr;
      if (!gw) return;
      setPlacingBr(null);
      try {
        const res = await fetch(api(`/api/gateways/${gw}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: pos.lat, lng: pos.lng }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.error ?? `Kaydedilemedi (${res.status})`);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Bilinmeyen hata");
      }
    },
    [placingBr, api, load],
  );

  const selectNode = useCallback(
    (id: string | null, withPop = false) => {
      setSelectedId(id);
      const n = id ? byId.get(id) : undefined;
      setPopId(withPop && n?.kind === "device" && located(n) ? id : null);
      setHover(null);
    },
    [byId],
  );

  // ── Harita katmanı ──
  const overlay: MeshOverlay | null = useMemo(() => {
    if (!mesh) return null;
    const nodes: OverlayNode[] = [];
    const links: OverlayLink[] = [];
    const lit = (n: MeshNode) => {
      const d = n.mac ? devByMac.get(n.mac) : undefined;
      return !!d && n.online && (d.lamps.length ? d.lamps.some(lampOn) : !!d.masterOn);
    };
    for (const n of mesh.nodes) {
      if (!located(n) || n.kind === "unknown") continue;
      const inactive = n.kind === "device" && (n.status === "offline" || n.status === "legacy" || n.status === "no_route" || n.status === "loop");
      const fill = n.hot
        ? palette.hot
        : n.weak
          ? palette.bad
          : inactive
            ? palette.offline
            : n.role === "router"
              ? palette.node
              : palette.node2;
      const isRouter = n.kind === "br" || n.role === "router";
      nodes.push({
        id: n.id,
        position: { lat: n.lat, lng: n.lng },
        shape: n.kind === "br" ? "br" : isRouter ? "router" : "child",
        fill,
        size: isRouter ? 19 + Math.min(n.load, 8) * 2.8 : 14,
        badge: n.kind === "device" && n.load > 0 ? n.load : null,
        badgeHot: n.hot,
        name: n.kind === "br" ? n.label : n.label,
        sub: n.kind === "br" ? `${rlocText(n.rloc16)} · ${n.label}` : rlocText(n.rloc16),
        tag: null,
        hollow: inactive,
        dim: focus !== null && n.kind !== "br" && !focus.has(n.id),
        selected: n.id === selectedId,
        lit: n.kind === "device" && lit(n),
        zIndex: n.id === selectedId ? 900 : n.kind === "br" ? 800 : n.hot ? 600 : isRouter ? 400 : 300,
      });
      if (!layers.routes || !n.parentId) continue;
      const p = byId.get(n.parentId);
      if (!p || !located(p)) continue;
      const color =
        colorMode === "link"
          ? n.linkCost === null
            ? palette.node2
            : n.linkCost <= 1
              ? palette.good
              : n.linkCost === 2
                ? palette.mid
                : palette.bad
          : n.upPpm / maxUp > 0.66
            ? palette.hot
            : n.upPpm / maxUp > 0.33
              ? palette.mid
              : palette.accent;
      links.push({
        id: n.id,
        from: { lat: n.lat, lng: n.lng },
        to: { lat: p.lat, lng: p.lng },
        color,
        width: Math.min(12, 2.2 + (n.load + 1) * 1.0),
        dashed: false,
        dim: focus !== null && !focus.has(n.id),
        flow: layers.flow,
        label: colorMode === "link" ? (n.linkCost !== null ? `+${n.linkCost}` : "?") : fmt(n.upPpm, n.upPpm < 10 ? 1 : 0),
      });
    }
    if (layers.sugg) {
      for (const s of mesh.suggestions) {
        if (!s.point) continue;
        const on = focus === null || focus.has(s.id);
        nodes.push({
          id: s.id,
          position: s.point,
          shape: s.kind === "br" ? "suggestion-br" : s.kind === "router" ? "suggestion-router" : "suggestion-check",
          fill: palette.sug,
          size: s.kind === "router" ? 30 : s.kind === "br" ? 30 : 24,
          badge: null,
          badgeHot: false,
          name: s.title,
          sub: null,
          tag: SUGG_TAG[s.kind],
          hollow: false,
          dim: !on,
          selected: s.id === selectedId,
          lit: false,
          zIndex: s.id === selectedId ? 950 : 700,
        });
        for (const id of s.links) {
          const t = byId.get(id);
          if (!t || !located(t)) continue;
          links.push({
            id: `${s.id}>${id}`,
            from: s.point,
            to: { lat: t.lat, lng: t.lng },
            color: palette.sug,
            width: 2.2,
            dashed: true,
            dim: !on,
            flow: false,
            label: null,
          });
        }
      }
    }
    const glow = layers.glow
      ? mesh.nodes.filter((n): n is MeshNode & { lat: number; lng: number } => n.kind === "device" && located(n) && lit(n)).map((n) => ({ lat: n.lat, lng: n.lng }))
      : [];
    return {
      nodes,
      links,
      glow,
      fitKey,
      dark,
      padding: { top: 56, right: 56, bottom: 56, left: 56 },
      onNodeClick: (id) => {
        if (byId.has(id) || mesh.suggestions.some((s) => s.id === id)) selectNode(id, true);
      },
      onNodeHover: (id, pt) => setHover(id && pt ? { id, ...pt } : null),
      onMapClick: (pos) => {
        if (placingBr) void pickBr(pos);
        else selectNode(null);
      },
      onView: (project) => {
        projectRef.current = project;
        cancelAnimationFrame(tickRaf.current);
        tickRaf.current = requestAnimationFrame(() => setViewTick((t) => t + 1));
      },
    };
  }, [mesh, byId, devByMac, focus, selectedId, colorMode, layers, maxUp, palette, dark, fitKey, placingBr, pickBr, selectNode]);

  // ── Harita üstü kart yerleşimi ──
  const popNode = popId ? byId.get(popId) : undefined;
  const [placement, setPlacement] = useState<PopPlacement | null>(null);
  useEffect(() => {
    const project = projectRef.current;
    const box = mapBox.current;
    if (!popNode || !located(popNode) || !project || !box || box.clientWidth < 640) {
      setPlacement(null);
      return;
    }
    const at = project({ lat: popNode.lat, lng: popNode.lng });
    if (!at) {
      setPlacement(null);
      return;
    }
    const avoid: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (let c: MeshNode | undefined = popNode; c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
      seen.add(c.id);
      if (!located(c)) continue;
      const pt = project({ lat: c.lat, lng: c.lng });
      if (pt) avoid.push([pt.x, pt.y], [pt.x, pt.y + 24], [pt.x - 30, pt.y + 20], [pt.x + 30, pt.y + 20]);
      const p = c.parentId ? byId.get(c.parentId) : undefined;
      if (pt && p && located(p)) {
        const q = project({ lat: p.lat, lng: p.lng });
        if (q) for (let t = 0; t <= 1; t += 0.1) avoid.push([pt.x + (q.x - pt.x) * t, pt.y + (q.y - pt.y) * t]);
      }
    }
    setPlacement(
      placePopover({
        x: at.x,
        y: at.y,
        width: POP_W,
        height: popRef.current?.offsetHeight || 170,
        gap: 22,
        containerWidth: box.clientWidth,
        containerHeight: box.clientHeight,
        avoid,
      }),
    );
  }, [popNode, viewTick, byId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPopId(null);
      setPlacingBr(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function search() {
    const q = query.trim().toLowerCase();
    if (!q || !mesh) return;
    const hexQ = q.replace(/^0x/, "");
    const hit = mesh.nodes.find(
      (n) =>
        n.kind !== "unknown" &&
        (n.label.toLowerCase() === q ||
          n.label.toLowerCase().endsWith(q.padStart(2, "0")) ||
          (n.rloc16 !== null && /^[0-9a-f]{1,4}$/.test(hexQ) && n.rloc16 === parseInt(hexQ, 16)) ||
          (n.mac ?? "").toLowerCase() === q.replace(/[^0-9a-f]/g, "")),
    );
    setNotFound(!hit);
    if (hit) selectNode(hit.id, true);
  }

  const kpi = mesh?.kpi;
  const label = (id: string | null) => (id ? (byId.get(id)?.label ?? "—") : "—");
  const hoverNode = hover ? byId.get(hover.id) : undefined;
  const hoverSugg = hover && !hoverNode ? mesh?.suggestions.find((s) => s.id === hover.id) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Ağ haritası"
        eyebrow="Thread mesh · yalnızca sistem yöneticisi"
        subtitle={
          kpi ? (
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-ok" />
              <b className="text-text">
                {kpi.onlineCount}/{kpi.deviceCount}
              </b>{" "}
              çevrimiçi · güncelleme <b className="text-text">{clockText(mesh!.at, now)}</b>
            </span>
          ) : (
            "Yükleniyor…"
          )
        }
        actions={
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
            className={`flex h-[38px] min-w-[240px] items-center gap-2 rounded-[10px] border bg-panel-2 px-3 ${
              notFound ? "border-danger" : "border-border focus-within:border-accent"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] fill-none stroke-muted stroke-2" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setNotFound(false);
              }}
              placeholder="Direk ara (ör. 05 veya 0x1c00)"
              aria-label="Direk ara"
              className="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            />
          </form>
        }
      />

      {error ? <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p> : null}

      {kpi ? (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Kpi dot="bg-ok" label="Çevrimiçi direk" value={kpi.onlineCount} unit={`/ ${kpi.deviceCount}`}>
            {kpi.onlineCount === kpi.deviceCount ? <span className="text-ok">tümü bağlı</span> : `${kpi.deviceCount - kpi.onlineCount} bağlantısız`}
            {" · "}
            {kpi.routerCount} router
          </Kpi>
          <Kpi dot="bg-accent" label="BR'ye giden trafik" value={fmt(kpi.totalUpPpm)} unit="paket/dk">
            ≈ {fmt(kpi.totalUpBytesPerMin / 1024, 1)} kB/dk · tahmini
          </Kpi>
          <Kpi
            dot="bg-muted"
            label="Ortalama yol maliyeti"
            value={kpi.avgPathCost !== null ? fmt(kpi.avgPathCost) : "—"}
            spark={<Sparkline values={mesh!.series.avgPathCost} color={palette.node2} />}
          >
            {kpi.farthestId ? `en uzak ${label(kpi.farthestId)} · ${kpi.maxHops} hop` : "rota verisi yok"}
          </Kpi>
          <Kpi dot="bg-[#d26e00]" label="Darboğaz router" value={kpi.hotIds.length}>
            {kpi.hotIds.length
              ? kpi.hotIds
                  .slice(0, 2)
                  .map((id) => `${label(id)} · ${byId.get(id)?.load ?? 0} direk`)
                  .join(", ")
              : "yok"}
          </Kpi>
          <Kpi
            dot="bg-danger"
            label="Parent değişimi · 24 sa"
            value={kpi.parentChanges24h}
            spark={<Sparkline values={mesh!.series.parentChanges} color={palette.bad} />}
          >
            {kpi.topParentChangesId ? `çoğu ${label(kpi.topParentChangesId)}` : "değişim yok"}
          </Kpi>
        </section>
      ) : null}

      <div className="grid items-start gap-3.5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-3.5 py-2.5">
            <div>
              <h2 className="text-[14px] font-semibold">Saha haritası ve mesh rotaları</h2>
              <div className="text-[12px] text-muted">
                Rota: health paketi <code className="font-mono">0xCE</code> next hop ·{" "}
                <code className="font-mono">0xCF</code> yol maliyeti
              </div>
            </div>
            <div role="group" aria-label="Renklendirme" className="flex overflow-hidden rounded-lg border border-border">
              {(
                [
                  ["link", "Link kalitesi"],
                  ["load", "Yük"],
                ] as const
              ).map(([k, t]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={colorMode === k}
                  onClick={() => setColorMode(k)}
                  className={`px-3 py-[5px] text-[12.5px] [&+&]:border-l [&+&]:border-border ${
                    colorMode === k ? "bg-accent-soft font-semibold text-accent" : "bg-panel text-muted"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div ref={mapBox} className="relative h-[clamp(520px,calc(100vh-330px),900px)] bg-panel-2">
            {/* İşaretçilerin z-index'i (≤ 950) kart ve düğmelerin önüne geçmesin. */}
            <div className="isolate h-full">
              <PoleMap poles={[]} mesh={overlay} addMode={placingBr !== null} />
            </div>

            <div className="absolute right-3 top-3 grid gap-1.5">
              <MapButton label="Katmanlar" pressed={layersOpen} onClick={() => setLayersOpen((o) => !o)}>
                <path d="m12 3 9 5-9 5-9-5 9-5Z" />
                <path d="m3 13 9 5 9-5" />
              </MapButton>
              <MapButton label="Tümünü göster" onClick={() => setFitKey(String(Date.now()))}>
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </MapButton>
            </div>
            {layersOpen ? (
              <div className="absolute right-14 top-3 grid min-w-[180px] gap-1.5 rounded-[10px] border border-border bg-panel p-2.5 text-[12.5px] shadow-lg">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted">Katmanlar</div>
                {(
                  [
                    ["routes", "Mesh rotaları"],
                    ["flow", "Trafik akışı"],
                    ["sugg", "Öneriler"],
                    ["glow", "Aydınlatma alanı"],
                  ] as const
                ).map(([k, t]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--acc-ink)]"
                      checked={layers[k]}
                      onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))}
                    />
                    {t}
                  </label>
                ))}
              </div>
            ) : null}

            {placingBr ? (
              <div className="pointer-events-none absolute inset-x-4 top-4 mx-auto max-w-sm rounded-xl border border-border bg-panel/95 px-4 py-2.5 text-center text-[13px] shadow-lg">
                Border router&apos;ın yerine tıklayın · Esc ile vazgeç
              </div>
            ) : null}

            {mesh && !mesh.nodes.some((n) => n.kind !== "unknown" && located(n)) ? (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 mx-auto max-w-md rounded-xl border border-border bg-panel/95 px-4 py-3 text-center text-[13px] text-ink-2 shadow-lg">
                Haritada gösterilecek konumlu direk yok. Direklere konum verin ve cihazları direklere bağlayın.
              </div>
            ) : null}

            {hover && (hoverNode || hoverSugg) && hover.id !== popId ? (
              <div
                className="pointer-events-none absolute z-[3] -translate-x-1/2 -translate-y-[calc(100%+12px)] whitespace-nowrap rounded-lg bg-[#141b23] px-2.5 py-2 text-[12px] leading-[1.45] text-[#e8edf2] shadow-xl"
                style={{ left: hover.x, top: hover.y }}
              >
                {hoverNode ? <HoverBody n={hoverNode} byId={byId} /> : <b className="text-white">{hoverSugg!.title}</b>}
              </div>
            ) : null}

            {popNode && placement ? (
              <div
                ref={popRef}
                className="absolute z-[4] box-border w-[250px] rounded-xl border border-border bg-panel px-3 pb-2.5 pt-3 shadow-[0_10px_30px_rgba(15,20,30,.22)]"
                style={{ left: placement.left, top: placement.top }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <PopArrow p={placement} />
                <PopBody
                  n={popNode}
                  byId={byId}
                  device={popNode.mac ? devByMac.get(popNode.mac) : undefined}
                  powerW={popNode.mac ? (live?.devices[popNode.mac]?.powerW ?? null) : null}
                  onClose={() => setPopId(null)}
                  onOpen={(mac) => {
                    const d = devByMac.get(mac);
                    if (d) openDevice(d);
                  }}
                />
              </div>
            ) : null}
          </div>

          <Legend mode={colorMode} palette={palette} />
        </section>

        <aside className="min-w-0 overflow-hidden rounded-2xl border border-border bg-panel" aria-live="polite">
          {mesh ? (
            <MeshPanel
              mesh={mesh}
              byId={byId}
              selectedId={selectedId}
              devices={devByMac}
              measures={live?.devices}
              onSelect={(id) => selectNode(id, false)}
              onOpenDevice={(mac) => {
                const d = devByMac.get(mac);
                if (d) openDevice(d);
              }}
              onPlaceBr={(gw) => setPlacingBr((cur) => (cur === gw ? null : gw))}
              placingBr={placingBr}
            />
          ) : (
            <p className="p-4 text-[13px] text-muted">Yükleniyor…</p>
          )}
        </aside>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border bg-panel">
        <div className="border-b border-border px-3.5 py-2.5">
          <h2 className="text-[14px] font-semibold">Son ağ olayları</h2>
          <div className="text-[12px] text-muted">health paketlerindeki değişimlerden üretilir (son 24 sa) · satıra tıklayın</div>
        </div>
        {mesh && mesh.events.length ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.07em] text-muted">
                  {["Saat", "Önem", "Direk", "Olay", "Kaynak alan"].map((h) => (
                    <th key={h} className="whitespace-nowrap border-b border-border px-3.5 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mesh.events.slice(0, 50).map((e, i) => {
                  const sev = SEV[e.severity];
                  return (
                    <tr
                      key={`${e.at}:${e.nodeId}:${i}`}
                      tabIndex={0}
                      onClick={() => {
                        selectNode(e.nodeId, true);
                        mapBox.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                      }}
                      onKeyDown={(k) => {
                        if (k.key === "Enter") selectNode(e.nodeId, true);
                      }}
                      className="cursor-pointer hover:bg-panel-2 [&:last-child>td]:border-b-0"
                    >
                      <td className="whitespace-nowrap border-b border-border px-3.5 py-2 font-mono text-[12px] text-muted">
                        {clockText(e.at, now)}
                      </td>
                      <td className="whitespace-nowrap border-b border-border px-3.5 py-2">
                        <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold ${sev.cls}`}>
                          <i className={`h-[7px] w-[7px] rounded-full ${sev.dot}`} />
                          {sev.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap border-b border-border px-3.5 py-2 font-semibold">{label(e.nodeId)}</td>
                      <td className="whitespace-nowrap border-b border-border px-3.5 py-2">{e.text}</td>
                      <td className="whitespace-nowrap border-b border-border px-3.5 py-2 font-mono text-[12px] text-muted">
                        {e.source}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-3.5 py-4 text-[13px] text-muted">{mesh ? "Son 24 saatte ağ olayı yok." : "Yükleniyor…"}</p>
        )}
      </section>
    </div>
  );
}

function Kpi({
  dot,
  label,
  value,
  unit,
  spark,
  children,
}: {
  dot: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
  spark?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-x-2 gap-y-0.5 rounded-2xl border border-border bg-panel px-3.5 pb-2.5 pt-3">
      <div className="col-span-2 flex items-center gap-1.5 text-[12px] text-muted">
        <i className={`h-[7px] w-[7px] rounded-full ${dot}`} />
        {label}
      </div>
      <div className="text-[24px] font-semibold leading-[1.15] tracking-[-0.01em] tabular-nums">
        {value}
        {unit ? <small className="ml-1 text-[12.5px] font-medium text-muted">{unit}</small> : null}
      </div>
      <div>{spark}</div>
      <div className="col-span-2 truncate text-[11.5px] text-muted">{children}</div>
    </div>
  );
}

function MapButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-panel text-text shadow-md hover:bg-panel-2"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current stroke-2" strokeLinecap="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function Legend({ mode, palette }: { mode: ColorMode; palette: (typeof MESH_COLORS)["light" | "dark"] }) {
  const line = (c: string, t: string) => (
    <span key={t} className="flex items-center gap-1.5 whitespace-nowrap">
      <i className="inline-block h-1 w-[18px] rounded-sm" style={{ background: c }} />
      {t}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 border-t border-border px-3.5 py-2 text-[12px] text-muted">
      {mode === "link"
        ? [line(palette.good, "link +1 iyi"), line(palette.mid, "+2 orta"), line(palette.bad, "+3 zayıf")]
        : [line(palette.accent, "düşük yük"), line(palette.mid, "orta"), line(palette.hot, "yüksek")]}
      <span>{mode === "link" ? "kalınlık = taşıdığı direk" : "etiket = paket/dk"}</span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: palette.node }} />
        router
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-[9px] w-[9px] rounded-sm" style={{ background: palette.node2 }} />
        child
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: palette.hot }} />
        darboğaz
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-[11px] w-[11px] rounded-full border-2 border-dashed" style={{ borderColor: palette.sug }} />
        öneri
      </span>
      <span className="flex items-center gap-1.5">
        <i className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: palette.offline }} />
        bağlantısız / rotasız
      </span>
    </div>
  );
}

function HoverBody({ n, byId }: { n: MeshNode; byId: ReadonlyMap<string, MeshNode> }) {
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3.5">
      <span className="text-[#9aa6b4]">{k}</span>
      {v}
    </div>
  );
  if (n.kind === "br") {
    return (
      <>
        <b className="text-[13px] text-white">Border Router</b>{" "}
        <span className="font-mono text-[11px] text-[#9aa6b4]">{rlocText(n.rloc16)}</span>
        {row("bağlı direk", n.load)}
        {row("doğrudan", n.children.length)}
      </>
    );
  }
  return (
    <>
      <b className="text-[13px] text-white">{n.label}</b>{" "}
      <span className="font-mono text-[11px] text-[#9aa6b4]">{rlocText(n.rloc16)}</span>
      {row("next hop", parent ? (parent.kind === "br" ? "BR" : parent.label) : rlocText(n.nextHop))}
      {row("yol maliyeti", `${n.pathCost ?? "—"}${n.hops !== null ? ` · ${n.hops} hop` : ""}`)}
      {row("yük ↑", `${fmt(n.upPpm)} paket/dk`)}
      {row("RSSI", n.link?.rssiAvg != null ? `${n.link.rssiAvg} dBm` : "—")}
    </>
  );
}

function PopArrow({ p }: { p: PopPlacement }) {
  const base = "absolute h-3 w-3 rotate-45 bg-panel";
  if (p.side === "left") return <i className={`${base} -left-[7px] -translate-y-1/2 border-b border-l border-border`} style={{ top: p.arrow }} />;
  if (p.side === "right") return <i className={`${base} -right-[7px] -translate-y-1/2 border-r border-t border-border`} style={{ top: p.arrow }} />;
  if (p.side === "top") return <i className={`${base} -top-[7px] -translate-x-1/2 border-l border-t border-border`} style={{ left: p.arrow }} />;
  return <i className={`${base} -bottom-[7px] -translate-x-1/2 border-b border-r border-border`} style={{ left: p.arrow }} />;
}

function PopBody({
  n,
  byId,
  device,
  powerW,
  onClose,
  onOpen,
}: {
  n: MeshNode;
  byId: ReadonlyMap<string, MeshNode>;
  device: import("@/app/_lib/types").DeviceView | undefined;
  powerW: number | null;
  onClose: () => void;
  onOpen: (mac: string) => void;
}) {
  const parent = n.parentId ? byId.get(n.parentId) : undefined;
  const lamps = device?.lamps ?? [];
  const lit = lamps.filter(lampOn);
  const level = lit.length ? Math.round(lit.reduce((s, l) => s + l.brightness, 0) / lit.length) : 0;
  const cell = (k: string, v: React.ReactNode) => (
    <div>
      <span className="block text-[11px] text-muted">{k}</span>
      <b className="tabular-nums">{v}</b>
    </div>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px]">{n.label}</b>
        <NodeTag node={n} />
        <button type="button" aria-label="Kapat" onClick={onClose} className="ml-auto px-1 text-[16px] leading-none text-muted">
          ×
        </button>
      </div>
      <div className="my-2.5 grid grid-cols-2 gap-x-2.5 gap-y-1.5 text-[12px]">
        {cell("Armatür", lit.length ? `Açık · %${level}` : lamps.length ? "Kapalı" : "—")}
        {cell("Güç", powerW !== null ? `${fmt(powerW, 0)} W` : "—")}
        {cell("Next hop", parent ? (parent.kind === "br" ? "BR" : parent.label) : rlocText(n.nextHop))}
        {cell("Yol maliyeti", `${n.pathCost ?? "—"}${n.hops !== null ? ` · ${n.hops} hop` : ""}`)}
      </div>
      {device ? (
        <button type="button" onClick={() => onOpen(device.deviceId)} className="btn-glow h-9 w-full text-[13px]">
          Cihaza git →
        </button>
      ) : null}
    </>
  );
}
