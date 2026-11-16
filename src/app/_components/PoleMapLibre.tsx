"use client";

import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { MapPole, PoleMapProps } from "./PoleMap";
import { POLE_COLOR, POLE_RED, poleHeadColors } from "@/app/_lib/poleColors";
import { KOCAELI } from "@/lib/sun";
import { useTheme } from "./ThemeProvider";

/**
 * Direk haritası — MapLibre GL + OpenStreetMap sürümü. Küçük haritalarda her
 * zaman, Haritalar sayfasında Google kotası dolduğunda / Google yokken
 * kullanılır (seçim: `PoleMap.tsx`).
 * Direkler tek GeoJSON kaynağında; uzaklaşınca
 * kümelenir (sorunlu direk içeren küme kırmızı), yakınlaşınca duruma göre
 * renkli noktalar ve numaralar görünür.
 *
 * Altlık: env'deki stil URL'si, yoksa anahtarsız OpenFreeMap (renkli liberty / koyu fiord; OSM verisi;
 * atıf haritada gösterilir). Tema değişince stil değişir, katmanlar
 * `style.load`'da yeniden kurulur.
 *
 * Yalnız istemcide çalışır (WebGL) — `next/dynamic` + `ssr:false` ile yüklenir.
 */


const STYLE_URL = {
  light: process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty",
  dark: process.env.NEXT_PUBLIC_MAP_STYLE_URL_DARK || "https://tiles.openfreemap.org/styles/fiord",
};

const COLOR = POLE_COLOR;
const RED = POLE_RED;

const SOURCE = "poles";

function toGeoJson(poles: MapPole[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: poles.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { id: p.id, code: p.code, state: p.state },
    })),
  };
}

/** Kaynak + katmanlar. Her stil yüklemesinde (tema değişimi dahil) çağrılır. */
function setupLayers(map: MLMap, dark: boolean, data: GeoJSON.FeatureCollection, compact: boolean) {
  if (map.getSource(SOURCE)) return;
  const stroke = dark ? "#1d1c1a" : "#ffffff";
  map.addSource(SOURCE, {
    type: "geojson",
    data,
    cluster: true,
    // Küçük kart haritasında daha az kümele: bölgenin direkleri tek tek görünsün.
    clusterMaxZoom: compact ? 13 : 15,
    clusterRadius: compact ? 24 : 42,
    // Kümedeki arızalı/bağlantısız direk sayısı — küme rengi için.
    clusterProperties: {
      problems: ["+", ["case", ["in", ["get", "state"], ["literal", ["fault", "offline"]]], 1, 0]],
    },
  });
  map.addLayer({
    id: "pole-clusters",
    type: "circle",
    source: SOURCE,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["case", [">", ["get", "problems"], 0], RED, dark ? "#e8e3d8" : "#3b3833"],
      "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24],
      "circle-stroke-width": 3,
      "circle-stroke-color": dark ? "rgba(29,28,26,.6)" : "rgba(255,255,255,.75)",
    },
  });
  map.addLayer({
    id: "pole-cluster-count",
    type: "symbol",
    source: SOURCE,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": ["case", [">", ["get", "problems"], 0], "#ffffff", dark ? "#1d1c1a" : "#ffffff"],
    },
  });
  map.addLayer({
    id: "pole-selected",
    type: "circle",
    source: SOURCE,
    filter: ["==", ["get", "id"], ""],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 18, 16],
      "circle-color": "rgba(240,163,26,.18)",
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#f0a31a",
    },
  });
  map.addLayer({
    id: "pole-points",
    type: "circle",
    source: SOURCE,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 15, 6.5, 18, 9],
      "circle-color": ["match", ["get", "state"], ...Object.entries(COLOR).flat(), COLOR.off] as never,
      "circle-stroke-width": ["case", ["==", ["get", "state"], "offline"], 2.5, 1.5],
      "circle-stroke-color": ["case", ["==", ["get", "state"], "offline"], RED, stroke],
    },
  });
  map.addLayer({
    id: "pole-labels",
    type: "symbol",
    source: SOURCE,
    filter: ["!", ["has", "point_count"]],
    minzoom: 16,
    layout: {
      "text-field": ["get", "code"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-offset": [0, 1.25],
      "text-anchor": "top",
    },
    paint: {
      "text-color": dark ? "#e8e3d8" : "#3b3833",
      "text-halo-color": dark ? "#1d1c1a" : "#ffffff",
      "text-halo-width": 1.4,
    },
  });
}

// ── 3 boyutlu görünüm ──────────────────────────────────────────────────────
// Direkler ek kütüphane olmadan, `fill-extrusion` ile çizilir: her direk birkaç
// yükseltilmiş çokgendir (kaide, gövde, konsol, armatür, ışık yüzeyi).
// Gerçek ölçüde (9 m) direk haritada birkaç piksel kalırdı; bu yüzden geometri
// yakınlaşmaya göre ölçeklenir ve direk ekranda yaklaşık sabit boyda durur.

const POLES3D = "poles-3d";
const BUILDINGS3D = "buildings-3d";
const GLOW = "pole-glow";
/** Direklerin 3B çizildiği en küçük yakınlaşma (kümeler bundan önce dağılmış olur). */
const MIN_ZOOM_3D = 15;
const POLE_HEIGHT_M = 9;
/** Direğin ekrandaki yaklaşık boyu (eğimsiz bakışta, piksel). */
const POLE_SCREEN_PX = 96;

/** Yakınlaşmaya göre direk ölçeği: 1 = gerçek boyut. */
function poleScale(zoom: number, lat: number): number {
  const metersPerPx = (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return Math.min(40, Math.max(1.5, (POLE_SCREEN_PX * metersPerPx) / POLE_HEIGHT_M));
}

type Pt = [number, number];

/** Metre cinsinden (doğu, kuzey) ötelemeleri direğin konumuna göre halkaya çevirir. */
function ringAt(lng: number, lat: number, pts: Pt[]): Pt[] {
  const dLat = 1 / 111_320;
  const dLng = dLat / Math.cos((lat * Math.PI) / 180);
  const ring: Pt[] = pts.map(([e, n]) => [lng + e * dLng, lat + n * dLat]);
  ring.push(ring[0]);
  return ring;
}

function octagon(r: number): Pt[] {
  return Array.from({ length: 8 }, (_, i): Pt => {
    const a = (Math.PI / 4) * i + Math.PI / 8;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
}

function rect(e0: number, e1: number, halfWidth: number): Pt[] {
  return [
    [e0, -halfWidth],
    [e1, -halfWidth],
    [e1, halfWidth],
    [e0, halfWidth],
  ];
}

/** Direklerin 3B parçaları. Kalınlıklar okunsun diye gerçeğinden iri tutuldu. */
function toPoles3d(poles: MapPole[], scale: number, dark: boolean): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const steel = dark ? "#c9c4ba" : "#4a4742";
  const steelDark = dark ? "#8f8a80" : "#2f2d2a";
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  for (const p of poles) {
    const { head, lens } = poleHeadColors(p.state, dark);
    const parts: Array<{ pts: Pt[]; base: number; height: number; color: string }> = [
      { pts: octagon(0.5), base: 0, height: 0.25, color: steelDark }, // taban flanşı
      { pts: octagon(0.34), base: 0.25, height: 1.1, color: steelDark }, // kaide
      { pts: octagon(0.21), base: 1.1, height: 5, color: steel }, // gövde (alt)
      { pts: octagon(0.16), base: 5, height: 9, color: steel }, // gövde (üst, incelen)
      { pts: rect(0, 2.3, 0.11), base: 8.72, height: 8.94, color: steel }, // konsol
      { pts: rect(1.45, 3.05, 0.42), base: 8.5, height: 8.78, color: head }, // armatür
      { pts: rect(1.6, 2.9, 0.3), base: 8.4, height: 8.5, color: lens }, // ışık yüzeyi
    ];
    for (const part of parts) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            ringAt(
              p.lng,
              p.lat,
              part.pts.map(([e, n]): Pt => [e * scale, n * scale]),
            ),
          ],
        },
        properties: { id: p.id, color: part.color, base: part.base * scale, height: part.height * scale },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * 3B katmanlarını kurar / gösterir / gizler. Stil her yüklendiğinde (tema
 * değişimi) ve görünüm değiştiğinde çağrılır.
 */
function apply3d(map: MLMap, on: boolean, dark: boolean, data: GeoJSON.FeatureCollection) {
  if (!map.getSource(SOURCE)) return;
  if (on) {
    // Binalar: OpenFreeMap (OpenMapTiles şeması). Özel stilde kaynak yoksa atlanır.
    // Stil kendi 3B binalarını getiriyorsa (liberty) ikincisi eklenmez: üst üste binip titrer.
    const styleHas3d = map.getStyle().layers.some((l) => l.type === "fill-extrusion" && l.id !== POLES3D);
    if (!styleHas3d && !map.getLayer(BUILDINGS3D) && map.getSource("openmaptiles")) {
      map.addLayer(
        {
          id: BUILDINGS3D,
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": dark ? "#46546a" : "#dcd8cf",
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.82,
          },
        },
        "pole-clusters",
      );
    }
    if (!map.getSource(POLES3D)) {
      map.addSource(POLES3D, { type: "geojson", data });
      // Yanan direğin yere düşen ışığı.
      map.addLayer(
        {
          id: GLOW,
          type: "circle",
          source: SOURCE,
          filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "state"], "on"]],
          minzoom: MIN_ZOOM_3D,
          paint: {
            "circle-radius": 46,
            "circle-color": "#ffc94d",
            "circle-opacity": dark ? 0.42 : 0.3,
            "circle-blur": 1,
            "circle-pitch-alignment": "map",
          },
        },
        "pole-selected",
      );
      map.addLayer(
        {
          id: POLES3D,
          type: "fill-extrusion",
          source: POLES3D,
          minzoom: MIN_ZOOM_3D,
          paint: {
            "fill-extrusion-color": ["get", "color"],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": 1,
          },
        },
        "pole-labels",
      );
    } else {
      (map.getSource(POLES3D) as GeoJSONSource).setData(data);
    }
  }
  for (const id of [BUILDINGS3D, GLOW, POLES3D]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
  // 3B'de nokta ve seçim halkası yere yatar: direğin tabanındaki disk olur.
  for (const id of ["pole-points", "pole-selected"]) {
    if (map.getLayer(id)) map.setPaintProperty(id, "circle-pitch-alignment", on ? "map" : "viewport");
  }
}

function fitTo(map: MLMap, poles: MapPole[], animate: boolean) {
  if (poles.length === 0) return;
  if (poles.length === 1) {
    map.jumpTo({ center: [poles[0].lng, poles[0].lat], zoom: 16 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  for (const p of poles) b.extend([p.lng, p.lat]);
  map.fitBounds(b, { padding: 48, maxZoom: 17, animate });
}

export function PoleMapLibre({
  poles,
  selectedId = null,
  onSelect,
  addMode = false,
  onAddAt,
  editPole = null,
  onMove,
  fitKey,
  focus = null,
  compact = false,
  preview = null,
  view3d = false,
  rotateDrag = false,
  className = "",
}: PoleMapProps) {
  const { resolved } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const fittedKey = useRef<string | null>(null);
  const isPreview = preview !== null;
  const previewRef = useRef(preview);

  // Olay işleyicileri harita bir kez kurulduğu için en güncel değerleri ref'ten okur.
  const latest = useRef({ poles, selectedId, onSelect, addMode, onAddAt, onMove, view3d, dark: resolved === "dark" });
  useEffect(() => {
    latest.current = { poles, selectedId, onSelect, addMode, onAddAt, onMove, view3d, dark: resolved === "dark" };
  });
  /** 3B direk geometrisinin üretildiği yakınlaşma (0,2'lik adımlarla yenilenir). */
  const zoom3d = useRef<number | null>(null);
  const refresh3dRef = useRef<((force: boolean) => void) | null>(null);

  // ── Kurulum (bir kez) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const dark = latest.current.dark;
    const pv = previewRef.current;
    const map = new maplibregl.Map({
      container: el,
      style: STYLE_URL[dark ? "dark" : "light"],
      center: pv ? [pv.lng, pv.lat] : [KOCAELI.lon, KOCAELI.lat],
      zoom: pv ? (pv.zoom ?? 16) : 11,
      maxPitch: 75,
      attributionControl: false,
      interactive: !pv,
      scrollZoom: !compact,
      cooperativeGestures: compact && !pv,
    });
    // Sağ taraf direk paneline ayrıldığı için kontroller solda.
    // Pusula yalnızca büyük haritada (3B'de yönü gösterir, tıklayınca kuzeye döner).
    if (!pv) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: !compact, visualizePitch: true }), "top-left");
    }
    // Önizlemede atıf kutusu açık gelir ve (etkileşim olmadığı için) kapanmaz,
    // küçük haritayı örter; atfı orada çağıran bileşen küçük yazıyla gösterir.
    if (!pv) map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    mapRef.current = map;

    map.on("style.load", () => {
      setupLayers(map, latest.current.dark, toGeoJson(latest.current.poles), compact);
      map.setFilter("pole-selected", ["==", ["get", "id"], latest.current.selectedId ?? ""]);
      refresh3d(true);
    });

    /** 3B katmanlarını güncel veri ve ölçekle yeniler (stil yüklenince, veri/zoom değişince). */
    function refresh3d(force: boolean) {
      const cur = latest.current;
      const step = Math.round(map.getZoom() * 5) / 5;
      if (!force && (!cur.view3d || step === zoom3d.current || step < MIN_ZOOM_3D - 0.5)) return;
      zoom3d.current = step;
      const data = cur.view3d
        ? toPoles3d(cur.poles, poleScale(step, map.getCenter().lat), cur.dark)
        : { type: "FeatureCollection" as const, features: [] };
      apply3d(map, cur.view3d, cur.dark, data);
    }
    refresh3dRef.current = refresh3d;
    map.on("zoom", () => refresh3d(false));

    // Tek tıklama işleyicisi: önce direk, sonra küme, yoksa boş alan
    // (ekleme modunda yeni konum, değilse seçimi kaldır).
    map.on("click", async (e) => {
      const cur = latest.current;
      if (!map.getLayer("pole-points")) return;
      const layers = ["pole-points", "pole-clusters", POLES3D].filter((l) => map.getLayer(l));
      const [hit] = map.queryRenderedFeatures(e.point, { layers });
      if (!hit || cur.addMode) {
        if (cur.addMode) cur.onAddAt?.(e.lngLat.lat, e.lngLat.lng);
        else cur.onSelect?.(null);
        return;
      }
      const props = hit.properties ?? {};
      if (hit.layer.id !== "pole-clusters") {
        cur.onSelect?.(props.id as string);
        return;
      }
      const src = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (!src || typeof props.cluster_id !== "number") return;
      const zoom = await src.getClusterExpansionZoom(props.cluster_id);
      map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });
    for (const layer of ["pole-points", "pole-clusters", POLES3D]) {
      map.on("mouseenter", layer, () => {
        if (!latest.current.addMode) map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = latest.current.addMode ? "crosshair" : "";
      });
    }

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
      refresh3dRef.current = null;
    };
  }, [compact]);

  // ── 3B görünüm: kamera eğilir, katmanlar açılır / kapanır ──
  const was3d = useRef(view3d);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || was3d.current === view3d) return;
    was3d.current = view3d;
    // latest ref'i bu render'ın değerini görsün diye bir sonraki karede.
    const raf = requestAnimationFrame(() => refresh3dRef.current?.(true));
    map.easeTo(
      view3d
        ? { pitch: 62, bearing: -20, zoom: Math.max(map.getZoom(), 16.5), duration: 900 }
        : { pitch: 0, bearing: 0, duration: 700 },
    );
    return () => cancelAnimationFrame(raf);
  }, [view3d]);

  // ── Tutup çevirme: sürükleme haritayı kaydırmak yerine döndürür ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !view3d || !rotateDrag) return;
    const canvas = map.getCanvas();
    let last: { id: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      // Yalnızca haritanın kendisi: işaretçi (sürüklenen direk) ve kontroller hariç.
      if (e.target !== canvas || e.button !== 0 || !e.isPrimary) return;
      last = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!last || e.pointerId !== last.id) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { id: last.id, x: e.clientX, y: e.clientY };
      map.jumpTo({
        bearing: map.getBearing() + dx * 0.45,
        pitch: Math.min(75, Math.max(0, map.getPitch() - dy * 0.35)),
      });
    };
    const up = () => {
      last = null;
    };
    map.dragPan.disable();
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      map.dragPan.enable();
      canvas.style.cursor = "";
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [view3d, rotateDrag]);

  // ── Tema: stil değişir, katmanlar style.load'da yeniden kurulur ──
  const themeRef = useRef(resolved);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === resolved) return;
    themeRef.current = resolved;
    map.setStyle(STYLE_URL[resolved === "dark" ? "dark" : "light"]);
  }, [resolved]);

  // ── Veri ──
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource(SOURCE) as GeoJSONSource | undefined;
    src?.setData(toGeoJson(poles));
    // latest ref'i bu render'ın direklerini görsün diye 3B yenilemesi bir sonraki karede.
    const raf = requestAnimationFrame(() => refresh3dRef.current?.(true));
    return () => cancelAnimationFrame(raf);
  }, [poles]);

  // ── Çerçeveleme: fitKey değişince (ve ilk veri geldiğinde) ──
  useEffect(() => {
    const map = mapRef.current;
    const key = fitKey ?? "";
    if (!map || isPreview || poles.length === 0 || fittedKey.current === key) return;
    const first = fittedKey.current === null;
    fittedKey.current = key;
    fitTo(map, poles, !first);
  }, [fitKey, poles, isPreview]);

  // ── Odak ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), 17) });
    // focus.key değişmedikçe aynı noktaya tekrar uçma.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  // ── Seçim ──
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("pole-selected")) {
      map.setFilter("pole-selected", ["==", ["get", "id"], selectedId ?? ""]);
    }
  }, [selectedId]);

  // ── Ekleme modu imleci ──
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = addMode ? "crosshair" : "";
  }, [addMode]);

  // ── Sürüklenebilir işaret (düzenleme) ──
  const editKey = editPole ? `${editPole.id}:${editPole.lat}:${editPole.lng}` : "";
  useEffect(() => {
    const map = mapRef.current;
    markerRef.current?.remove();
    markerRef.current = null;
    if (!map || !editPole) return;
    const marker = new maplibregl.Marker({ draggable: true, color: "#f0a31a" })
      .setLngLat([editPole.lng, editPole.lat])
      .addTo(map);
    marker.on("dragend", () => {
      const p = marker.getLngLat();
      latest.current.onMove?.(editPole.id, p.lat, p.lng);
    });
    markerRef.current = marker;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey]);

  if (!isPreview) return <div ref={containerRef} className={`h-full w-full ${className}`} />;
  // Önizlemede atıf kutusu haritayı örtüyordu; yerine tek satırlık küçük atıf.
  return (
    <div className={`relative h-full w-full ${className}`}>
      <div ref={containerRef} className="h-full w-full" />
      <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-panel/80 px-1 text-[9.5px] leading-[14px] text-muted">
        © OpenFreeMap · OpenStreetMap
      </span>
    </div>
  );
}
