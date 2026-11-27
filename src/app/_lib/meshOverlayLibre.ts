/**
 * Ağ haritası katmanı — MapLibre GL. Bağlar ve aydınlatma alanı GeoJSON
 * katmanı (tema değişiminde `setStyle` katmanları siler: `style.load`'da
 * yeniden kurulur), düğümler ve etiketler HTML işaretçi (stilden bağımsız).
 */
import maplibregl, { type GeoJSONSource, type Map as MLMap, type MapMouseEvent } from "maplibre-gl";
import {
  GLOW_RADIUS_M,
  MESH_COLORS,
  MESH_LABEL_ZOOM,
  applyPaletteVars,
  bindNodeEvents,
  boundsOf,
  curvePath,
  ensureMeshStyles,
  reducedMotion,
  renderNodeElement,
  renderPillElement,
  type MeshLayer,
  type MeshOverlay,
} from "./meshOverlay";

const LINKS = "mo-links";
const GLOW = "mo-glow";

/** Akış animasyonu: kısa çizgi parçaları hat boyunca kayar (MapLibre örneği). */
const DASH_SEQ: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

const empty = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

/** Metre → piksel yarıçapı, yakınlaşmaya göre (Web Mercator). */
function glowRadius(lat: number): maplibregl.ExpressionSpecification {
  const mpp0 = 156543.03392 * Math.cos((lat * Math.PI) / 180);
  return ["interpolate", ["exponential", 2], ["zoom"], 0, GLOW_RADIUS_M / mpp0, 24, (GLOW_RADIUS_M / mpp0) * 2 ** 24];
}

export function attachMeshLibre(map: MLMap): MeshLayer {
  ensureMeshStyles();
  const container = map.getContainer();
  let current: MeshOverlay | null = null;
  let fitted: string | null = null;
  let linkData = empty();
  let glowData = empty();
  let glowLat = 40.76;
  const nodes = new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>();
  const pills = new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>();
  let raf = 0;
  let step = 0;
  let lastTick = 0;

  function setup() {
    if (!map.getSource(LINKS)) {
      map.addSource(GLOW, { type: "geojson", data: glowData });
      map.addSource(LINKS, { type: "geojson", data: linkData });
      map.addLayer({
        id: "mo-glow",
        type: "circle",
        source: GLOW,
        paint: { "circle-color": "#ffc846", "circle-opacity": ["get", "opacity"], "circle-radius": glowRadius(glowLat) },
      });
      map.addLayer({
        id: "mo-link-halo",
        type: "line",
        source: LINKS,
        filter: ["==", ["get", "dashed"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "halo"],
          "line-width": ["+", ["get", "width"], 3],
          "line-opacity": ["case", ["get", "dim"], 0, 0.85],
        },
      });
      map.addLayer({
        id: "mo-link",
        type: "line",
        source: LINKS,
        filter: ["==", ["get", "dashed"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["get", "width"],
          "line-opacity": ["case", ["get", "dim"], 0.15, 0.95],
        },
      });
      map.addLayer({
        id: "mo-link-dashed",
        type: "line",
        source: LINKS,
        filter: ["==", ["get", "dashed"], true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["get", "width"],
          "line-dasharray": [2, 2],
          "line-opacity": ["case", ["get", "dim"], 0.2, 0.95],
        },
      });
      map.addLayer({
        id: "mo-flow",
        type: "line",
        source: LINKS,
        filter: ["all", ["==", ["get", "flow"], true], ["==", ["get", "dim"], false]],
        layout: { "line-cap": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": ["max", 1.5, ["*", ["get", "width"], 0.42]],
          "line-opacity": 0.9,
          "line-dasharray": DASH_SEQ[0],
        },
      });
    }
  }
  /** Stil hazır değilken addSource hata verir; o zaman style.load / idle bekler. */
  const trySetup = () => {
    try {
      setup();
    } catch {
      /* stil yükleniyor */
    }
  };
  trySetup();
  const onStyle = () => trySetup();
  map.on("idle", onStyle);
  map.on("style.load", onStyle);

  const syncLabels = () => container.classList.toggle("mo-labels", map.getZoom() >= MESH_LABEL_ZOOM);
  syncLabels();
  const emitView = () => {
    current?.onView?.((ll) => {
      const p = map.project([ll.lng, ll.lat]);
      return { x: p.x, y: p.y };
    });
  };
  const onZoom = () => syncLabels();
  const onClick = (e: MapMouseEvent) => {
    if ((e.originalEvent.target as Element | null)?.closest?.(".mo-node")) return;
    current?.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  };
  map.on("zoom", onZoom);
  map.on("move", emitView);
  map.on("click", onClick);

  function animate(now: number) {
    raf = requestAnimationFrame(animate);
    if (now - lastTick < 60) return;
    lastTick = now;
    step = (step + 1) % DASH_SEQ.length;
    if (map.getLayer("mo-flow")) map.setPaintProperty("mo-flow", "line-dasharray", DASH_SEQ[step]);
  }

  function update(o: MeshOverlay) {
    current = o;
    const c = o.dark ? MESH_COLORS.dark : MESH_COLORS.light;
    applyPaletteVars(container, o.dark);
    if (!map.getSource(LINKS)) trySetup();

    const seen = new Set<string>();
    for (const n of o.nodes) {
      seen.add(n.id);
      let e = nodes.get(n.id);
      if (!e) {
        // MapLibre işaretçi öğesini kendisi konumlar (sınıf + position: absolute):
        // düğüm DOM'u ayrı bir iç öğede, sarmalayıcıya dokunulmaz.
        const wrap = document.createElement("div");
        const el = document.createElement("div");
        wrap.append(el);
        bindNodeEvents(el, () => container, () => current);
        const marker = new maplibregl.Marker({ element: wrap, anchor: "center" })
          .setLngLat([n.position.lng, n.position.lat])
          .addTo(map);
        e = { marker, el };
        nodes.set(n.id, e);
      }
      renderNodeElement(e.el, n);
      e.marker.setLngLat([n.position.lng, n.position.lat]);
      e.marker.getElement().style.zIndex = String(n.zIndex);
    }
    for (const [id, e] of nodes) {
      if (seen.has(id)) continue;
      e.marker.remove();
      nodes.delete(id);
    }

    const features: GeoJSON.Feature[] = [];
    const seenP = new Set<string>();
    for (const l of o.links) {
      const { path, mid } = curvePath(l.from, l.to);
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
        properties: { color: l.color, width: l.width, dashed: l.dashed, dim: l.dim, flow: l.flow, halo: c.halo },
      });
      if (!l.label) continue;
      seenP.add(l.id);
      let p = pills.get(l.id);
      if (!p) {
        const wrap = document.createElement("div");
        wrap.style.pointerEvents = "none";
        const el = document.createElement("div");
        wrap.append(el);
        p = { el, marker: new maplibregl.Marker({ element: wrap, anchor: "center" }).setLngLat([mid.lng, mid.lat]).addTo(map) };
        pills.set(l.id, p);
      }
      p.marker.setLngLat([mid.lng, mid.lat]);
      renderPillElement(p.el, l);
    }
    for (const [id, p] of pills) {
      if (seenP.has(id)) continue;
      p.marker.remove();
      pills.delete(id);
    }
    linkData = { type: "FeatureCollection", features };
    (map.getSource(LINKS) as GeoJSONSource | undefined)?.setData(linkData);

    glowData = {
      type: "FeatureCollection",
      features: o.glow.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { opacity: o.dark ? 0.18 : 0.3 },
      })),
    };
    if (o.glow.length) {
      const lat = o.glow[0].lat;
      if (Math.abs(lat - glowLat) > 0.5 && map.getLayer("mo-glow")) {
        map.setPaintProperty("mo-glow", "circle-radius", glowRadius(lat));
      }
      glowLat = lat;
    }
    (map.getSource(GLOW) as GeoJSONSource | undefined)?.setData(glowData);

    const wantFlow = o.links.some((l) => l.flow && !l.dim) && !reducedMotion();
    if (wantFlow && !raf) raf = requestAnimationFrame(animate);
    if (!wantFlow && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    if (fitted !== o.fitKey) {
      const b = boundsOf(o.nodes.map((n) => n.position));
      if (b) {
        const first = fitted === null;
        fitted = o.fitKey;
        if (b.sw.lat === b.ne.lat && b.sw.lng === b.ne.lng) {
          map.jumpTo({ center: [b.sw.lng, b.sw.lat], zoom: 18 });
        } else {
          map.fitBounds(
            [
              [b.sw.lng, b.sw.lat],
              [b.ne.lng, b.ne.lat],
            ],
            { padding: o.padding ?? 48, maxZoom: 19, animate: !first },
          );
        }
      }
    }
    emitView();
  }

  function destroy() {
    if (raf) cancelAnimationFrame(raf);
    current = null;
    try {
      teardown();
    } catch {
      /* harita önce kaldırıldıysa (bileşen sökümü) yapılacak bir şey yok */
    }
  }

  function teardown() {
    map.off("style.load", onStyle);
    map.off("idle", onStyle);
    map.off("zoom", onZoom);
    map.off("move", emitView);
    map.off("click", onClick);
    for (const e of nodes.values()) e.marker.remove();
    for (const p of pills.values()) p.marker.remove();
    nodes.clear();
    pills.clear();
    for (const id of ["mo-flow", "mo-link-dashed", "mo-link", "mo-link-halo", "mo-glow"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of [LINKS, GLOW]) if (map.getSource(id)) map.removeSource(id);
    container.classList.remove("mo-labels");
    current = null;
  }

  return { update, destroy };
}
