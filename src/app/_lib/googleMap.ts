import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { KOCAELI } from "@/lib/sun";

/**
 * Google Maps örnek havuzu.
 *
 * Google her `new google.maps.Map` çağrısını ("map load") faturalar. Bu yüzden
 * haritalar ayrık `div`'lerde kurulur ve sökülünce YOK EDİLMEZ, havuza geri
 * konur; bir sonraki harita (aynı tür + tema) havuzdakini alır. Sayfalar arası
 * gezinme, kartların açılıp kapanması ve mini haritaların ekrana girip çıkması
 * yeni yükleme yazmaz. Sekme başına yükleme sayısı = aynı anda ekranda olan
 * en fazla harita sayısı (tür ve tema başına).
 *
 * Türler (seçenekleri kurulumda farklı):
 * - `main`: Haritalar sayfası (tam kontrol)
 * - `compact`: bölge kartı (kaydırma için iki parmak / Ctrl)
 * - `preview`: arıza mini haritası (etkileşimsiz)
 * Açık / koyu tema ayrı örnektir (renk şeması yalnızca kurulumda verilebiliyor).
 *
 * Yeni harita kurmadan önce sunucuya sorulur (`POST /api/map/session`): kota
 * sayacı uygunsa artırılır. Uygun değilse `null` döner ve çağıran MapLibre +
 * OpenStreetMap çizer. Yalnızca Maps JavaScript API kullanılır; Places,
 * Geocoding, Routes, Street View, Static Maps yoktur (ayrı faturalanırlar).
 */

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() ?? "";

export type MapScheme = "light" | "dark";
export type MapKind = "main" | "compact" | "preview";

export interface GoogleMapHandle {
  map: google.maps.Map;
  /** Haritanın kök öğesi; sayfadaki kaba `appendChild` ile takılır. */
  div: HTMLDivElement;
  scheme: MapScheme;
  kind: MapKind;
}

/** Anahtar ve Map ID derlemeye gömülmüş mü? */
export function googleMapsEnabled(): boolean {
  return API_KEY !== "" && MAP_ID !== "";
}

/** Boşta bekleyen haritalar, `kind:scheme` başına. */
const free = new Map<string, GoogleMapHandle[]>();
/** Kurulmuş bütün haritalar (hata anında hepsi sökülür). */
const all = new Set<GoogleMapHandle>();
/** Bu sekmede Google kullanılamaz (anahtar/kota hatası): sayfa yenilenene kadar. */
let failed = false;
/** Sunucu "kota dolu" dediyse tekrar sormadan önce beklenecek an. */
let deniedUntil = 0;
const DENY_RETRY_MS = 30 * 60_000;

const failureListeners = new Set<() => void>();
let optionsSet = false;

/** Google çalışma anında kullanılamaz olursa (anahtar, kota) haber verir. */
export function onGoogleMapFailure(fn: () => void): () => void {
  failureListeners.add(fn);
  return () => {
    failureListeners.delete(fn);
  };
}

function markFailed(reason: unknown) {
  if (failed) return;
  failed = true;
  console.warn("[harita] Google Maps kullanılamıyor, OpenStreetMap çiziliyor:", reason);
  for (const h of all) h.div.remove();
  all.clear();
  free.clear();
  for (const fn of failureListeners) fn();
}

async function serverAllows(): Promise<boolean> {
  try {
    const res = await fetch("/api/map/session", { method: "POST" });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { provider?: string } };
    return json.data?.provider === "google";
  } catch {
    return false;
  }
}

/** Türün dinlenme hâlindeki hareket ayarı (3B döndürme bunu geçici değiştirir). */
export function restingGesture(kind: MapKind): "none" | "cooperative" | "greedy" {
  return kind === "preview" ? "none" : kind === "compact" ? "cooperative" : "greedy";
}

function optionsFor(kind: MapKind): google.maps.MapOptions {
  switch (kind) {
    case "preview":
      return {
        disableDefaultUI: true,
        gestureHandling: "none",
        keyboardShortcuts: false,
      };
    case "compact":
      return {
        disableDefaultUI: true,
        zoomControl: true,
        zoomControlOptions: { position: google.maps.ControlPosition.LEFT_TOP },
        gestureHandling: "cooperative",
      };
    default:
      return {
        disableDefaultUI: true,
        zoomControl: true,
        zoomControlOptions: { position: google.maps.ControlPosition.LEFT_TOP },
        gestureHandling: "greedy",
      };
  }
}

async function create(kind: MapKind, scheme: MapScheme): Promise<GoogleMapHandle | null> {
  if (!(await serverAllows())) {
    deniedUntil = Date.now() + DENY_RETRY_MS;
    return null;
  }
  try {
    if (!optionsSet) {
      optionsSet = true;
      // Geçersiz anahtar, referrer ya da kota: Google bu genel işlevi çağırır.
      (window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => markFailed("gm_authFailure");
      setOptions({ key: API_KEY, v: "weekly", language: "tr", region: "TR", mapIds: [MAP_ID] });
    }
    const [{ Map: GMap }] = await Promise.all([importLibrary("maps"), importLibrary("marker")]);
    if (failed) return null;
    const div = document.createElement("div");
    div.style.width = "100%";
    div.style.height = "100%";
    const map = new GMap(div, {
      mapId: MAP_ID,
      colorScheme: scheme === "dark" ? "DARK" : "LIGHT",
      center: { lat: KOCAELI.lat, lng: KOCAELI.lon },
      zoom: 11,
      tilt: 0,
      heading: 0,
      isFractionalZoomEnabled: true,
      // İlgi noktası tıklamaları kapalı: bilgi balonu Places verisi getirirdi.
      clickableIcons: false,
      tiltInteractionEnabled: false,
      headingInteractionEnabled: false,
      ...optionsFor(kind),
    });
    // Kota aşımında Google `gm_authFailure` çağırmadan haritanın yerine hata
    // kutusu koyabilir; görülürse OpenStreetMap çizilir.
    new MutationObserver((_, observer) => {
      if (div.querySelector(".gm-err-container")) {
        observer.disconnect();
        markFailed("gm-err-container");
      }
    }).observe(div, { childList: true, subtree: true });
    const handle: GoogleMapHandle = { map, div, scheme, kind };
    all.add(handle);
    return handle;
  } catch (err) {
    markFailed(err);
    return null;
  }
}

/**
 * Bu tür ve tema için bir Google haritası verir: havuzda boşta varsa onu, yoksa
 * (kota uygunsa) yenisini kurar. `null` → OpenStreetMap çizilmeli. İş bitince
 * `releaseGoogleMap` ile geri verilmelidir.
 */
export async function acquireGoogleMap(kind: MapKind, scheme: MapScheme): Promise<GoogleMapHandle | null> {
  if (!googleMapsEnabled() || failed) return null;
  const idle = free.get(`${kind}:${scheme}`)?.pop();
  if (idle) return idle;
  if (Date.now() < deniedUntil) return null;
  return create(kind, scheme);
}

/** Haritayı havuza geri verir (yok etmez). Çağırmadan önce `div` sökülmüş olmalı. */
export function releaseGoogleMap(handle: GoogleMapHandle): void {
  if (failed || !all.has(handle)) return;
  const key = `${handle.kind}:${handle.scheme}`;
  const list = free.get(key) ?? [];
  if (!list.includes(handle)) list.push(handle);
  free.set(key, list);
}
