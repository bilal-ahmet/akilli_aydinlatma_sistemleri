"use client";

import { MarkerClusterer, SuperClusterAlgorithm, type Renderer } from "@googlemaps/markerclusterer";
import { useEffect, useRef } from "react";
import { restingGesture, type GoogleMapHandle } from "@/app/_lib/googleMap";
import type { Poles3d } from "@/app/_lib/googlePoles3d";
import { POLE_COLOR, POLE_RED } from "@/app/_lib/poleColors";
import type { PoleState } from "@/app/_lib/poles";
import type { MapPole, PoleMapProps } from "./PoleMap";

/**
 * Direk haritası — Google Maps sürümü (yalnızca Haritalar sayfası).
 *
 * Harita örneği bu bileşene ait DEĞİLDİR: `googleMap.ts` onu sekme başına bir
 * kez kurar; burada yalnızca hazır `div` sayfaya takılır, çıkarken sökülür
 * (yok edilmez). Böylece sayfaya her gelişte Google'a yeni "harita yüklemesi"
 * yazılmaz. İşaretçiler, kümeler ve dinleyiciler ise bileşenle yaşar.
 *
 * Direkler `AdvancedMarkerElement` (durum renkli nokta), uzaklaşınca kümelenir
 * (sorunlu direk içeren küme kırmızı). 3B görünümde kamera eğilir, binaları
 * Google çizer, direk modelleri `googlePoles3d.ts` (three.js) ile gelir.
 */

const STYLE_ID = "pm-google-style";
const LABEL_ZOOM = 17;
const MAX_TILT = 67.5;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const states = (Object.keys(POLE_COLOR) as PoleState[])
    .map((s) => `.pm-pole[data-state="${s}"]{--pm-c:${POLE_COLOR[s]}}`)
    .join("");
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.pm-pole{position:relative;width:15px;height:15px;transform:translateY(50%);cursor:pointer}
.pm-dot{display:block;box-sizing:border-box;width:15px;height:15px;border-radius:50%;background:var(--pm-c);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)}
[data-pm-dark="1"] .pm-dot{border-color:#1d1c1a}
${states}
.pm-pole[data-state="offline"] .pm-dot,[data-pm-dark="1"] .pm-pole[data-state="offline"] .pm-dot{border:3px solid ${POLE_RED}}
.pm-pole[data-selected="1"]::before{content:"";position:absolute;inset:-9px;border-radius:50%;border:2.5px solid #f0a31a;background:rgba(240,163,26,.2)}
.pm-label{display:none;position:absolute;top:18px;left:50%;transform:translateX(-50%);white-space:nowrap;font:500 11px/1 system-ui,sans-serif;color:#3b3833;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff}
[data-pm-dark="1"] .pm-label{color:#e8e3d8;text-shadow:0 0 2px #1d1c1a,0 0 2px #1d1c1a,0 0 3px #1d1c1a}
[data-pm-labels="1"] .pm-label{display:block}
.pm-cluster{display:grid;place-items:center;border-radius:50%;transform:translateY(50%);background:#3b3833;color:#fff;font:700 12px/1 system-ui,sans-serif;border:3px solid rgba(255,255,255,.75);cursor:pointer}
[data-pm-dark="1"] .pm-cluster{background:#e8e3d8;color:#1d1c1a;border-color:rgba(29,28,26,.6)}
.pm-cluster[data-problem="1"],[data-pm-dark="1"] .pm-cluster[data-problem="1"]{background:${POLE_RED};color:#fff}
`;
  document.head.appendChild(style);
}

interface Entry {
  marker: google.maps.marker.AdvancedMarkerElement;
  el: HTMLDivElement;
  label: HTMLSpanElement;
  pole: MapPole;
}

// Harita öğeleri React'in dışında yaşar; değişiklikler bu yardımcılardan geçer.
function setFlag(el: HTMLElement, key: string, on: boolean) {
  el.dataset[key] = on ? "1" : "0";
}
function unmap(marker: google.maps.marker.AdvancedMarkerElement) {
  marker.map = null;
}

/** Kamerayı yumuşakça eğer / döndürür (Google'da `moveCamera` anlıktır). */
function tweenCamera(
  map: google.maps.Map,
  to: { tilt: number; heading: number; zoom?: number },
  ms: number,
): () => void {
  const from = { tilt: map.getTilt() ?? 0, heading: map.getHeading() ?? 0, zoom: map.getZoom() ?? 0 };
  // En kısa yoldan dön (350° → -10°).
  const dh = ((((to.heading - from.heading) % 360) + 540) % 360) - 180;
  const dz = to.zoom === undefined ? 0 : to.zoom - from.zoom;
  const start = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    map.moveCamera({
      tilt: from.tilt + (to.tilt - from.tilt) * e,
      heading: from.heading + dh * e,
      ...(dz !== 0 ? { zoom: from.zoom + dz * e } : {}),
    });
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export function PoleMapGoogle({
  handle,
  dark,
  poles,
  selectedId = null,
  onSelect,
  addMode = false,
  onAddAt,
  editPole = null,
  onMove,
  fitKey,
  focus = null,
  view3d = false,
  rotateDrag = false,
  preview = null,
  className = "",
}: PoleMapProps & { handle: GoogleMapHandle; dark: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<string, Entry>());
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const poles3dRef = useRef<Poles3d | null>(null);
  const fittedKey = useRef<string | null>(null);
  const { map, div, kind } = handle;

  // Dinleyiciler bir kez kurulduğu için en güncel değerleri ref'ten okur.
  const latest = useRef({ poles, onSelect, addMode, onAddAt, onMove, view3d, dark });
  useEffect(() => {
    latest.current = { poles, onSelect, addMode, onAddAt, onMove, view3d, dark };
  });

  // ── Takma / sökme ──
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureStyles();
    setFlag(div, "pmDark", dark);
    container.appendChild(div);
    const markers = entries.current;

    const states = new WeakMap<object, PoleState>();
    const renderer: Renderer = {
      render({ count, position, markers: members }) {
        const problem = (members ?? []).some((m) => {
          const s = states.get(m);
          return s === "fault" || s === "offline";
        });
        const el = document.createElement("div");
        el.className = "pm-cluster";
        el.dataset.problem = problem ? "1" : "0";
        const size = count < 10 ? 30 : count < 50 ? 38 : 48;
        el.style.width = el.style.height = `${size}px`;
        el.textContent = String(count);
        return new google.maps.marker.AdvancedMarkerElement({ position, content: el, zIndex: 1000 + count });
      },
    };
    const clusterer = new MarkerClusterer({
      map,
      renderer,
      algorithm: new SuperClusterAlgorithm({ maxZoom: 15, radius: 60 }),
    });
    clustererRef.current = clusterer;
    statesRef.current = states;

    const syncLabels = () => {
      setFlag(div, "pmLabels", (map.getZoom() ?? 0) >= LABEL_ZOOM);
    };
    syncLabels();
    const listeners = [
      map.addListener("zoom_changed", syncLabels),
      map.addListener("click", (e: google.maps.MapMouseEvent) => {
        const cur = latest.current;
        if (cur.addMode) {
          if (e.latLng) cur.onAddAt?.(e.latLng.lat(), e.latLng.lng());
        } else {
          cur.onSelect?.(null);
        }
      }),
    ];

    return () => {
      for (const l of listeners) l.remove();
      clusterer.clearMarkers(true);
      clusterer.setMap(null);
      clustererRef.current = null;
      for (const e of markers.values()) unmap(e.marker);
      markers.clear();
      // Harita saklanır: bir sonraki açılış için düz (2B) duruma çekilir.
      poles3dRef.current?.setVisible(false);
      map.setTiltInteractionEnabled(false);
      map.setHeadingInteractionEnabled(false);
      map.setOptions({ draggableCursor: null, gestureHandling: restingGesture(kind) });
      map.moveCamera({ tilt: 0, heading: 0 });
      div.remove();
    };
  }, [map, div, dark, kind]);
  const statesRef = useRef<WeakMap<object, PoleState> | null>(null);

  // ── İşaretçiler: direk listesiyle eşitle ──
  useEffect(() => {
    const clusterer = clustererRef.current;
    const states = statesRef.current;
    if (!clusterer || !states) return;
    const known = entries.current;
    const seen = new Set<string>();
    let membership = false;
    let stateChanged = false;

    for (const pole of poles) {
      seen.add(pole.id);
      let entry = known.get(pole.id);
      if (!entry) {
        const el = document.createElement("div");
        el.className = "pm-pole";
        const dot = document.createElement("span");
        dot.className = "pm-dot";
        const label = document.createElement("span");
        label.className = "pm-label";
        el.append(dot, label);
        const marker = new google.maps.marker.AdvancedMarkerElement({
          position: { lat: pole.lat, lng: pole.lng },
          content: el,
          gmpClickable: true,
        });
        const id = pole.id;
        marker.addEventListener("gmp-click", () => {
          // Önizlemede tıklama dışarıdaki bağlantıya ait.
          if (kind === "preview") return;
          if (!latest.current.addMode) latest.current.onSelect?.(id);
        });
        entry = { marker, el, label, pole };
        known.set(pole.id, entry);
        membership = true;
      } else {
        if (entry.pole.lat !== pole.lat || entry.pole.lng !== pole.lng) {
          entry.marker.position = { lat: pole.lat, lng: pole.lng };
          membership = true;
        }
        if (entry.pole.state !== pole.state) stateChanged = true;
        entry.pole = pole;
      }
      entry.el.dataset.state = pole.state;
      entry.el.dataset.selected = pole.id === selectedId ? "1" : "0";
      entry.label.textContent = pole.code;
      entry.marker.zIndex = pole.id === selectedId ? 900 : pole.state === "fault" || pole.state === "offline" ? 500 : 100;
      states.set(entry.marker, pole.state);
    }
    for (const [id, entry] of known) {
      if (seen.has(id)) continue;
      unmap(entry.marker);
      known.delete(id);
      membership = true;
    }

    if (membership) {
      clusterer.clearMarkers(true);
      clusterer.addMarkers([...known.values()].map((e) => e.marker));
    } else if (stateChanged) {
      // Küme rengi içindeki direklerin durumuna bağlı.
      clusterer.render();
    }
  }, [poles, selectedId, kind]);

  // ── Önizleme: sabit nokta ──
  const previewKey = preview ? `${preview.lat}:${preview.lng}:${preview.zoom ?? 16}` : "";
  useEffect(() => {
    if (!preview) return;
    map.moveCamera({ center: { lat: preview.lat, lng: preview.lng }, zoom: preview.zoom ?? 16, tilt: 0, heading: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, map]);

  // ── Çerçeveleme: fitKey değişince (ve ilk veri geldiğinde) ──
  useEffect(() => {
    const key = fitKey ?? "";
    if (preview || poles.length === 0 || fittedKey.current === key) return;
    const first = fittedKey.current === null;
    fittedKey.current = key;
    // İlk açılışta odak verilmişse o kazanır (aşağıdaki etki).
    if (first && focus) return;
    if (poles.length === 1) {
      map.moveCamera({ center: { lat: poles[0].lat, lng: poles[0].lng }, zoom: 17 });
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const p of poles) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 48);
    // Birbirine çok yakın direklerde aşırı yakınlaşmayı sınırla.
    google.maps.event.addListenerOnce(map, "idle", () => {
      if ((map.getZoom() ?? 0) > 18) map.setZoom(18);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, poles, map]);

  // ── Odak ──
  useEffect(() => {
    if (!focus) return;
    map.moveCamera({ center: { lat: focus.lat, lng: focus.lng }, zoom: Math.max(map.getZoom() ?? 0, 18) });
    // focus.key değişmedikçe aynı noktaya tekrar gitme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key, map]);

  // ── Ekleme modu imleci ──
  useEffect(() => {
    map.setOptions({ draggableCursor: addMode ? "crosshair" : null });
  }, [addMode, map]);

  // ── Sürüklenebilir işaret (düzenleme) ──
  const editKey = editPole ? `${editPole.id}:${editPole.lat}:${editPole.lng}` : "";
  useEffect(() => {
    if (!editPole) return;
    const id = editPole.id;
    const marker = new google.maps.marker.AdvancedMarkerElement({
      map,
      position: { lat: editPole.lat, lng: editPole.lng },
      gmpDraggable: true,
      zIndex: 5000,
    });
    const listener = marker.addListener("dragend", (e: google.maps.MapMouseEvent) => {
      if (e.latLng) latest.current.onMove?.(id, e.latLng.lat(), e.latLng.lng());
    });
    return () => {
      listener.remove();
      unmap(marker);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editKey, map]);

  // ── 3B görünüm: kamera eğilir, direk modelleri açılır / kapanır ──
  const was3d = useRef(false);
  useEffect(() => {
    if (was3d.current === view3d) return;
    was3d.current = view3d;
    map.setTiltInteractionEnabled(view3d);
    map.setHeadingInteractionEnabled(view3d);
    if (!view3d) {
      poles3dRef.current?.setVisible(false);
      return tweenCamera(map, { tilt: 0, heading: 0 }, 700);
    }
    let alive = true;
    // three.js yalnızca 3B ilk açıldığında yüklenir.
    import("@/app/_lib/googlePoles3d").then(({ getPoles3d }) => {
      if (!alive) return;
      const layer = getPoles3d(map);
      poles3dRef.current = layer;
      layer.setPoles(latest.current.poles, latest.current.dark);
      layer.setVisible(true);
    });
    const cancel = tweenCamera(
      map,
      { tilt: 62, heading: -20, zoom: Math.max(map.getZoom() ?? 0, 17.5) },
      900,
    );
    return () => {
      alive = false;
      cancel();
    };
  }, [view3d, map]);

  // ── 3B direkler: veri değişince ──
  useEffect(() => {
    if (view3d) poles3dRef.current?.setPoles(poles, dark);
  }, [poles, dark, view3d]);

  // ── Tutup çevirme: sürükleme haritayı kaydırmak yerine döndürür ──
  useEffect(() => {
    if (!view3d || !rotateDrag) return;
    let last: { id: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !e.isPrimary) return;
      // İşaretçiler, kümeler ve harita kontrolleri kendi tıklamasını alır.
      if ((e.target as Element | null)?.closest?.("gmp-advanced-marker, .pm-pole, .pm-cluster, button, a")) return;
      last = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!last || e.pointerId !== last.id) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { id: last.id, x: e.clientX, y: e.clientY };
      map.moveCamera({
        heading: (map.getHeading() ?? 0) + dx * 0.45,
        tilt: Math.min(MAX_TILT, Math.max(0, (map.getTilt() ?? 0) - dy * 0.35)),
      });
    };
    const up = () => {
      last = null;
    };
    map.setOptions({ gestureHandling: "none", draggableCursor: "grab" });
    div.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      map.setOptions({
        gestureHandling: restingGesture(kind),
        draggableCursor: latest.current.addMode ? "crosshair" : null,
      });
      div.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [view3d, rotateDrag, map, div, kind]);

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
}
