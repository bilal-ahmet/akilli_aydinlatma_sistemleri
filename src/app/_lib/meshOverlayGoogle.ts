/**
 * Ağ haritası katmanı — Google Maps. Harita havuzdan gelir ve başka sayfada
 * yeniden kullanılır: `destroy()` çizdiği her şeyi kaldırır.
 */
import {
  GLOW_RADIUS_M,
  MESH_COLORS,
  MESH_LABEL_ZOOM,
  applyPaletteVars,
  bindNodeEvents,
  clickNode,
  boundsOf,
  curvePath,
  ensureMeshStyles,
  reducedMotion,
  renderNodeElement,
  renderPillElement,
  type MeshLayer,
  type MeshOverlay,
  type OverlayLink,
} from "./meshOverlay";

interface LinkEntry {
  halo: google.maps.Polyline;
  line: google.maps.Polyline;
  pill: google.maps.marker.AdvancedMarkerElement;
  pillEl: HTMLDivElement;
  link: OverlayLink;
}

const FLOW_REPEAT = 18;

export function attachMeshGoogle(map: google.maps.Map, container: HTMLElement): MeshLayer {
  ensureMeshStyles();
  container.classList.add("mo-gm");
  let current: MeshOverlay | null = null;
  let fitted: string | null = null;
  const nodes = new Map<string, { marker: google.maps.marker.AdvancedMarkerElement; el: HTMLDivElement }>();
  const links = new Map<string, LinkEntry>();
  let glow: google.maps.Circle[] = [];
  let flowOffset = 0;
  let flowTimer: ReturnType<typeof setInterval> | null = null;

  // Projeksiyon için boş OverlayView.
  const proj = new google.maps.OverlayView();
  proj.onAdd = () => {};
  proj.draw = () => emitView();
  proj.onRemove = () => {};
  proj.setMap(map);

  function emitView() {
    const p = proj.getProjection();
    if (!p || !current?.onView) return;
    current.onView((ll) => {
      const pt = p.fromLatLngToContainerPixel(new google.maps.LatLng(ll.lat, ll.lng));
      return pt ? { x: pt.x, y: pt.y } : null;
    });
  }
  const syncLabels = () => container.classList.toggle("mo-labels", (map.getZoom() ?? 0) >= MESH_LABEL_ZOOM);
  syncLabels();
  const listeners = [
    map.addListener("zoom_changed", syncLabels),
    map.addListener("bounds_changed", emitView),
    map.addListener("click", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) current?.onMapClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    }),
  ];

  function lineIcons(l: OverlayLink, c: (typeof MESH_COLORS)["light" | "dark"]): google.maps.IconSequence[] {
    const icons: google.maps.IconSequence[] = [];
    if (l.dashed) {
      icons.push({
        icon: { path: "M 0,-1 0,1", strokeOpacity: l.dim ? 0.2 : 1, strokeColor: l.color, scale: Math.max(2, l.width / 2) },
        offset: "0",
        repeat: "10px",
      });
    }
    if (l.flow && !l.dim) {
      icons.push({
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: Math.max(1.2, l.width * 0.22),
          fillColor: c.flow,
          fillOpacity: 0.95,
          strokeOpacity: 0,
        },
        offset: `${flowOffset}px`,
        repeat: `${FLOW_REPEAT}px`,
      });
    }
    return icons;
  }

  function syncFlowTimer() {
    const any = [...links.values()].some((e) => e.link.flow && !e.link.dim);
    if (any && !flowTimer && !reducedMotion()) {
      flowTimer = setInterval(() => {
        flowOffset = (flowOffset + 1) % FLOW_REPEAT;
        for (const e of links.values()) {
          if (!e.link.flow || e.link.dim) continue;
          const icons = e.line.get("icons") as google.maps.IconSequence[] | undefined;
          if (!icons?.length) continue;
          const last = icons[icons.length - 1];
          last.offset = `${flowOffset}px`;
          e.line.set("icons", icons);
        }
      }, 70);
    } else if (!any && flowTimer) {
      clearInterval(flowTimer);
      flowTimer = null;
    }
  }

  function update(o: MeshOverlay) {
    current = o;
    const c = o.dark ? MESH_COLORS.dark : MESH_COLORS.light;
    applyPaletteVars(container, o.dark);

    // Düğümler
    const seen = new Set<string>();
    for (const n of o.nodes) {
      seen.add(n.id);
      let e = nodes.get(n.id);
      if (!e) {
        const el = document.createElement("div");
        bindNodeEvents(el, () => container, () => current);
        const marker = new google.maps.marker.AdvancedMarkerElement({ map, content: el, gmpClickable: true });
        marker.addEventListener("gmp-click", () => clickNode(el, current));
        e = { marker, el };
        nodes.set(n.id, e);
      }
      renderNodeElement(e.el, n);
      const pos = e.marker.position as google.maps.LatLngLiteral | null;
      if (!pos || pos.lat !== n.position.lat || pos.lng !== n.position.lng) e.marker.position = n.position;
      e.marker.zIndex = n.zIndex;
    }
    for (const [id, e] of nodes) {
      if (seen.has(id)) continue;
      e.marker.map = null;
      nodes.delete(id);
    }

    // Bağlar
    const seenL = new Set<string>();
    for (const l of o.links) {
      seenL.add(l.id);
      const { path, mid } = curvePath(l.from, l.to);
      let e = links.get(l.id);
      if (!e) {
        const pillEl = document.createElement("div");
        e = {
          halo: new google.maps.Polyline({ map, clickable: false, zIndex: 9 }),
          line: new google.maps.Polyline({ map, clickable: false, zIndex: 10 }),
          pill: new google.maps.marker.AdvancedMarkerElement({ map, content: pillEl, zIndex: 50 }),
          pillEl,
          link: l,
        };
        links.set(l.id, e);
      }
      e.link = l;
      e.halo.setOptions({
        path,
        strokeColor: c.halo,
        strokeOpacity: l.dim || l.dashed ? 0 : 0.85,
        strokeWeight: l.width + 3,
      });
      e.line.setOptions({
        path,
        strokeColor: l.color,
        strokeOpacity: l.dashed ? 0 : l.dim ? 0.15 : 0.95,
        strokeWeight: l.width,
        icons: lineIcons(l, c),
      });
      e.pill.position = mid;
      e.pill.map = l.label ? map : null;
      renderPillElement(e.pillEl, l);
    }
    for (const [id, e] of links) {
      if (seenL.has(id)) continue;
      e.halo.setMap(null);
      e.line.setMap(null);
      e.pill.map = null;
      links.delete(id);
    }
    syncFlowTimer();

    // Aydınlatma alanı
    for (const g of glow) g.setMap(null);
    glow = o.glow.map(
      (p) =>
        new google.maps.Circle({
          map,
          center: p,
          radius: GLOW_RADIUS_M,
          fillColor: "#ffc846",
          fillOpacity: o.dark ? 0.18 : 0.3,
          strokeOpacity: 0,
          clickable: false,
          zIndex: 1,
        }),
    );

    // Çerçeveleme
    if (fitted !== o.fitKey) {
      const b = boundsOf(o.nodes.map((n) => n.position));
      if (b) {
        fitted = o.fitKey;
        if (b.sw.lat === b.ne.lat && b.sw.lng === b.ne.lng) {
          map.moveCamera({ center: b.sw, zoom: 18 });
        } else {
          map.fitBounds(new google.maps.LatLngBounds(b.sw, b.ne), o.padding ?? 48);
          google.maps.event.addListenerOnce(map, "idle", () => {
            if ((map.getZoom() ?? 0) > 19) map.setZoom(19);
          });
        }
      }
    }
    emitView();
  }

  function destroy() {
    for (const l of listeners) l.remove();
    if (flowTimer) clearInterval(flowTimer);
    for (const e of nodes.values()) e.marker.map = null;
    for (const e of links.values()) {
      e.halo.setMap(null);
      e.line.setMap(null);
      e.pill.map = null;
    }
    for (const g of glow) g.setMap(null);
    nodes.clear();
    links.clear();
    glow = [];
    proj.setMap(null);
    container.classList.remove("mo-gm", "mo-labels");
    current = null;
  }

  return { update, destroy };
}
