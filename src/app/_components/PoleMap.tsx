"use client";

import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { PoleState } from "@/app/_lib/poles";
import { KOCAELI } from "@/lib/sun";
import { useTheme } from "./ThemeProvider";

/**
 * Direk haritası (MapLibre GL). Direkler tek GeoJSON kaynağında; uzaklaşınca
 * kümelenir (sorunlu direk içeren küme kırmızı), yakınlaşınca duruma göre
 * renkli noktalar ve numaralar görünür.
 *
 * Altlık: env'deki stil URL'si, yoksa anahtarsız OpenFreeMap (OSM verisi;
 * atıf haritada gösterilir). Tema değişince stil değişir, katmanlar
 * `style.load`'da yeniden kurulur.
 *
 * Yalnız istemcide çalışır (WebGL) — `next/dynamic` + `ssr:false` ile yüklenir.
 */

export interface MapPole {
  id: string;
  code: string;
  lat: number;
  lng: number;
  state: PoleState;
}

const STYLE_URL = {
  light: process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron",
  dark: process.env.NEXT_PUBLIC_MAP_STYLE_URL_DARK || "https://tiles.openfreemap.org/styles/dark",
};

/** MapLibre oklch okuyamadığı için tema renklerinin hex karşılıkları. */
const COLOR: Record<PoleState, string> = {
  on: "#f0a31a",
  off: "#8f8a80",
  fault: "#d63a2f",
  offline: "#ffffff",
  no_device: "#cfcac0",
};
const RED = "#d63a2f";

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

export function PoleMap({
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
  className = "",
}: {
  /** Konumu olan direkler. */
  poles: MapPole[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Açıkken haritaya tıklama yeni direk konumu verir. */
  addMode?: boolean;
  onAddAt?: (lat: number, lng: number) => void;
  /** Sürüklenerek taşınacak direk (düzenleme). */
  editPole?: { id: string; lat: number; lng: number } | null;
  onMove?: (id: string, lat: number, lng: number) => void;
  /** Değişince harita tüm direkleri kapsayacak şekilde yeniden çerçevelenir. */
  fitKey?: string;
  /** Verilince o noktaya yakınlaşılır (`key` değişince). */
  focus?: { key: string; lat: number; lng: number } | null;
  /** Küçük kart haritası: kaydırma ile yakınlaşma kapalı. */
  compact?: boolean;
  className?: string;
}) {
  const { resolved } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const fittedKey = useRef<string | null>(null);

  // Olay işleyicileri harita bir kez kurulduğu için en güncel değerleri ref'ten okur.
  const latest = useRef({ poles, selectedId, onSelect, addMode, onAddAt, onMove, dark: resolved === "dark" });
  useEffect(() => {
    latest.current = { poles, selectedId, onSelect, addMode, onAddAt, onMove, dark: resolved === "dark" };
  });

  // ── Kurulum (bir kez) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const dark = latest.current.dark;
    const map = new maplibregl.Map({
      container: el,
      style: STYLE_URL[dark ? "dark" : "light"],
      center: [KOCAELI.lon, KOCAELI.lat],
      zoom: 11,
      attributionControl: false,
      scrollZoom: !compact,
      cooperativeGestures: compact,
    });
    // Sağ taraf direk paneline ayrıldığı için kontroller solda.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    mapRef.current = map;

    map.on("style.load", () => {
      setupLayers(map, latest.current.dark, toGeoJson(latest.current.poles), compact);
      map.setFilter("pole-selected", ["==", ["get", "id"], latest.current.selectedId ?? ""]);
    });

    // Tek tıklama işleyicisi: önce direk, sonra küme, yoksa boş alan
    // (ekleme modunda yeni konum, değilse seçimi kaldır).
    map.on("click", async (e) => {
      const cur = latest.current;
      if (!map.getLayer("pole-points")) return;
      const [hit] = map.queryRenderedFeatures(e.point, { layers: ["pole-points", "pole-clusters"] });
      if (!hit || cur.addMode) {
        if (cur.addMode) cur.onAddAt?.(e.lngLat.lat, e.lngLat.lng);
        else cur.onSelect?.(null);
        return;
      }
      const props = hit.properties ?? {};
      if (hit.layer.id === "pole-points") {
        cur.onSelect?.(props.id as string);
        return;
      }
      const src = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (!src || typeof props.cluster_id !== "number") return;
      const zoom = await src.getClusterExpansionZoom(props.cluster_id);
      map.easeTo({ center: (hit.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });
    for (const layer of ["pole-points", "pole-clusters"]) {
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
    };
  }, [compact]);

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
  }, [poles]);

  // ── Çerçeveleme: fitKey değişince (ve ilk veri geldiğinde) ──
  useEffect(() => {
    const map = mapRef.current;
    const key = fitKey ?? "";
    if (!map || poles.length === 0 || fittedKey.current === key) return;
    const first = fittedKey.current === null;
    fittedKey.current = key;
    fitTo(map, poles, !first);
  }, [fitKey, poles]);

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

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
}
