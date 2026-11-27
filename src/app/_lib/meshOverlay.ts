/**
 * Ağ haritası katmanı — iki harita sağlayıcısının (Google / MapLibre) ortak
 * sözleşmesi ve DOM parçaları. Düğümler (direk, BR, öneri) ve bağ etiketleri
 * HTML işaretçidir (iki sağlayıcıda aynı görünüm); bağlar sağlayıcının kendi
 * çizgileridir (`meshOverlayGoogle.ts`, `meshOverlayLibre.ts`).
 *
 * Renkler hex: harita motorları temadaki oklch değişkenlerini okuyamaz.
 */

export type LatLng = { lat: number; lng: number };

export type MeshNodeShape = "router" | "child" | "br" | "unknown" | "suggestion-br" | "suggestion-router" | "suggestion-check";

export interface OverlayNode {
  id: string;
  position: LatLng;
  shape: MeshNodeShape;
  /** Gövde rengi (hex). */
  fill: string;
  /** Gövde çapı (px). */
  size: number;
  /** Sağ üst rozet: taşıdığı direk sayısı. */
  badge: number | null;
  badgeHot: boolean;
  /** Ad (direk no) ve alt satır (RLOC16). */
  name: string;
  sub: string | null;
  /** Öneri etiketi ("öneri: ara router"). */
  tag: string | null;
  /** Bağlantısız: içi boş, soluk. */
  hollow: boolean;
  dim: boolean;
  selected: boolean;
  /** Yanan armatür (ortadaki sarı nokta). */
  lit: boolean;
  zIndex: number;
}

export interface OverlayLink {
  id: string;
  from: LatLng;
  to: LatLng;
  color: string;
  width: number;
  dashed: boolean;
  dim: boolean;
  /** Trafik akışı animasyonu (from → to). */
  flow: boolean;
  /** Orta noktadaki etiket (+1 / paket/dk). */
  label: string | null;
}

export interface MeshOverlay {
  nodes: OverlayNode[];
  links: OverlayLink[];
  /** "Aydınlatma alanı": yanan direklerin çevresi. */
  glow: LatLng[];
  /** Değişince bütün düğümler çerçevelenir. */
  fitKey: string;
  dark: boolean;
  /** Çerçevelemede sağ/alt panel payı (px). */
  padding?: { top: number; right: number; bottom: number; left: number };
  onNodeClick?: (id: string) => void;
  /** Ekran noktası harita kabına göre (px); null = ayrıldı. */
  onNodeHover?: (id: string | null, point: { x: number; y: number } | null) => void;
  onMapClick?: (pos: LatLng) => void;
  /** Kaydırma / yakınlaşmada: enlem-boylam → harita kabı pikseli. */
  onView?: (project: (p: LatLng) => { x: number; y: number } | null) => void;
}

/** Bir sağlayıcıya takılmış katman. */
export interface MeshLayer {
  update(overlay: MeshOverlay): void;
  destroy(): void;
}

export const MESH_COLORS = {
  light: {
    good: "#16915f",
    mid: "#b88300",
    bad: "#cc3d3d",
    hot: "#d26e00",
    accent: "#2563eb",
    sug: "#6d4ae0",
    node: "#1f2a37",
    node2: "#748092",
    offline: "#a7afb9",
    panel: "#ffffff",
    halo: "#ffffff",
    flow: "#ffffff",
  },
  dark: {
    good: "#38c08a",
    mid: "#e0b13a",
    bad: "#f06c6c",
    hot: "#ff9a33",
    accent: "#6e9cff",
    sug: "#a88bff",
    node: "#e3e8ee",
    node2: "#97a2af",
    offline: "#5d6773",
    panel: "#141a21",
    halo: "#141a21",
    flow: "#ffffff",
  },
} as const;
export type MeshPalette = (typeof MESH_COLORS)["light"] | (typeof MESH_COLORS)["dark"];

/** Etiketler bu yakınlaşmadan itibaren görünür. */
export const MESH_LABEL_ZOOM = 16;
/** "Aydınlatma alanı" yarıçapı (m). */
export const GLOW_RADIUS_M = 25;

/**
 * İki nokta arasında hafif kavisli yol (aynı doğrultudaki bağlar üst üste
 * binmesin; tasarımdaki eğri). Düzlemsel yaklaşım, kısa mesafeler için yeterli.
 */
export function curvePath(a: LatLng, b: LatLng, segments = 12): { path: LatLng[]; mid: LatLng } {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) || 1;
  const ax = a.lng * k;
  const bx = b.lng * k;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy) || 1e-9;
  const bend = len * 0.12;
  const cx = (ax + bx) / 2 - (dy / len) * bend;
  const cy = (a.lat + b.lat) / 2 + (dx / len) * bend;
  const at = (t: number): LatLng => {
    const u = 1 - t;
    const x = u * u * ax + 2 * u * t * cx + t * t * bx;
    const y = u * u * a.lat + 2 * u * t * cy + t * t * b.lat;
    return { lat: y, lng: x / k };
  };
  const path: LatLng[] = [];
  for (let i = 0; i <= segments; i++) path.push(at(i / segments));
  return { path, mid: at(0.5) };
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

const STYLE_ID = "mesh-overlay-style";

export function ensureMeshStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.mo-node{position:relative;cursor:pointer;outline:none;transition:opacity .2s;font-family:var(--font-sans,system-ui),sans-serif}
.mo-gm .mo-node{transform:translateY(50%)}
.mo-node[data-dim="1"]{opacity:.18}
.mo-body{display:block;box-sizing:border-box;width:var(--mo-s);height:var(--mo-s);background:var(--mo-f);border:2.5px solid var(--mo-panel);box-shadow:0 1px 3px rgba(0,0,0,.35)}
.mo-node[data-shape="router"] .mo-body,.mo-node[data-shape="unknown"] .mo-body{border-radius:50%}
.mo-node[data-shape="child"] .mo-body{border-radius:3px}
.mo-node[data-shape="unknown"] .mo-body{background:var(--mo-panel);border:2px dashed var(--mo-f)}
.mo-node[data-hollow="1"] .mo-body{background:var(--mo-panel);border:2.5px solid var(--mo-f)}
.mo-node::before{content:"";position:absolute;inset:-6px;border-radius:50%;border:2.5px solid var(--mo-acc);opacity:0;pointer-events:none}
.mo-node[data-shape="child"]::before{border-radius:6px}
.mo-node:hover::before,.mo-node:focus-visible::before{opacity:.55}
.mo-node[data-sel="1"]::before{opacity:1;border-width:3px}
.mo-core{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:#ffd45a;display:none}
.mo-node[data-lit="1"] .mo-core{display:block}
.mo-badge{position:absolute;right:-9px;top:-9px;min-width:17px;height:17px;padding:0 3px;box-sizing:border-box;border-radius:9px;display:grid;place-items:center;font:700 10px/1 inherit;background:var(--mo-node);color:var(--mo-panel);border:1.5px solid var(--mo-panel)}
.mo-badge[data-hot="1"]{background:var(--mo-hot);color:#fff}
.mo-text{position:absolute;left:50%;top:calc(100% + 4px);transform:translateX(-50%);white-space:nowrap;text-align:center;line-height:1.15;pointer-events:none;display:none}
.mo-labels .mo-text,.mo-node[data-sel="1"] .mo-text{display:block}
.mo-name{display:block;font:600 11.5px/1.15 inherit;color:var(--mo-ink);text-shadow:0 0 3px var(--mo-panel),0 0 3px var(--mo-panel),0 0 4px var(--mo-panel)}
.mo-sub{display:block;font:400 9.5px/1.2 ui-monospace,Consolas,monospace;color:var(--mo-muted);text-shadow:0 0 3px var(--mo-panel),0 0 3px var(--mo-panel)}
.mo-node[data-shape="br"] .mo-body{width:auto;height:auto;border-radius:9px;padding:5px 10px;background:#141b23;border:2px solid var(--mo-panel);text-align:center}
.mo-br-t{display:block;font:700 10px/1.1 inherit;letter-spacing:.07em;color:#fff;white-space:nowrap}
.mo-br-s{display:block;font:400 9px/1.2 ui-monospace,Consolas,monospace;color:#9aa6b4;white-space:nowrap}
.mo-node[data-shape^="suggestion"] .mo-body{background:var(--mo-sug-soft);border:2.2px dashed var(--mo-sug);border-radius:50%;display:grid;place-items:center;font:700 13px/1 inherit;color:var(--mo-sug);box-shadow:none}
.mo-node[data-shape="suggestion-br"] .mo-body{border-radius:8px;width:auto;padding:0 10px;font-size:11px}
.mo-pulse{position:absolute;inset:0;border-radius:inherit;border:2px solid var(--mo-sug);animation:mo-pulse 2.2s ease-out infinite;pointer-events:none}
.mo-node[data-shape="suggestion-br"] .mo-pulse{border-radius:8px}
@keyframes mo-pulse{from{transform:scale(.8);opacity:.7}to{transform:scale(1.7);opacity:0}}
.mo-tag{position:absolute;left:50%;top:calc(100% + 5px);transform:translateX(-50%);white-space:nowrap;border-radius:9px;padding:2px 8px;font:600 10px/1.3 inherit;background:var(--mo-sug);color:#fff;pointer-events:none}
.mo-pill{box-sizing:border-box;border-radius:9px;padding:1px 6px;font:600 10px/1.4 ui-monospace,Consolas,monospace;background:var(--mo-panel);border:1.3px solid currentColor;white-space:nowrap;pointer-events:none;transition:opacity .2s;display:none}
.mo-gm .mo-pill{transform:translateY(50%)}
.mo-labels .mo-pill{display:block}
.mo-pill[data-dim="1"]{opacity:.15}
@media (prefers-reduced-motion:reduce){.mo-pulse{animation:none}}
`;
  document.head.appendChild(style);
}

/** Kabın tema değişkenleri (düğüm DOM'u bunları okur). */
export function applyPaletteVars(el: HTMLElement, dark: boolean) {
  const c = dark ? MESH_COLORS.dark : MESH_COLORS.light;
  el.style.setProperty("--mo-panel", c.panel);
  el.style.setProperty("--mo-node", c.node);
  el.style.setProperty("--mo-hot", c.hot);
  el.style.setProperty("--mo-acc", c.accent);
  el.style.setProperty("--mo-sug", c.sug);
  el.style.setProperty("--mo-sug-soft", dark ? "#251e3d" : "#efeafe");
  el.style.setProperty("--mo-ink", dark ? "#e3e8ee" : "#18202a");
  el.style.setProperty("--mo-muted", dark ? "#97a2af" : "#606b78");
}

/** Düğüm işaretçisinin içeriği; aynı öğe yeniden kullanılır (yalnızca değişen yazılır). */
export function renderNodeElement(el: HTMLElement, n: OverlayNode) {
  el.className = "mo-node";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", n.tag ? `Öneri: ${n.name}` : n.name);
  el.dataset.id = n.id;
  el.dataset.shape = n.shape;
  el.dataset.dim = n.dim ? "1" : "0";
  el.dataset.sel = n.selected ? "1" : "0";
  el.dataset.hollow = n.hollow ? "1" : "0";
  el.dataset.lit = n.lit ? "1" : "0";
  el.style.setProperty("--mo-f", n.fill);
  el.style.setProperty("--mo-s", `${n.size}px`);
  const key = [n.shape, n.badge, n.badgeHot, n.name, n.sub, n.tag].join("|");
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.replaceChildren();
  const body = document.createElement("span");
  body.className = "mo-body";
  if (n.shape === "br") {
    const t = document.createElement("span");
    t.className = "mo-br-t";
    t.textContent = "BORDER ROUTER";
    const s = document.createElement("span");
    s.className = "mo-br-s";
    s.textContent = n.sub ?? n.name;
    body.append(t, s);
    el.append(body);
    return;
  }
  if (n.shape.startsWith("suggestion")) {
    body.textContent = n.shape === "suggestion-br" ? "BR-2" : n.shape === "suggestion-router" ? "+" : "!";
    body.style.height = `${n.size}px`;
    if (n.shape !== "suggestion-check") {
      const pulse = document.createElement("span");
      pulse.className = "mo-pulse";
      body.append(pulse);
    }
    el.append(body);
    if (n.tag) {
      const tag = document.createElement("span");
      tag.className = "mo-tag";
      tag.textContent = n.tag;
      el.append(tag);
    }
    return;
  }
  const core = document.createElement("span");
  core.className = "mo-core";
  body.append(core);
  el.append(body);
  if (n.badge !== null && n.badge > 0) {
    const b = document.createElement("span");
    b.className = "mo-badge";
    b.dataset.hot = n.badgeHot ? "1" : "0";
    b.textContent = String(n.badge);
    el.append(b);
  }
  const text = document.createElement("span");
  text.className = "mo-text";
  const name = document.createElement("span");
  name.className = "mo-name";
  name.textContent = n.name;
  text.append(name);
  if (n.sub) {
    const sub = document.createElement("span");
    sub.className = "mo-sub";
    sub.textContent = n.sub;
    text.append(sub);
  }
  el.append(text);
}

export function renderPillElement(el: HTMLElement, l: OverlayLink) {
  el.className = "mo-pill";
  el.textContent = l.label ?? "";
  el.style.color = l.color;
  el.dataset.dim = l.dim ? "1" : "0";
}

/**
 * Tek tıklama tek seçim: Google'da hem DOM `click` hem `gmp-click` gelebilir,
 * aynı öğeye 300 ms içinde ikinci çağrı yutulur.
 */
export function clickNode(el: HTMLElement, overlay: MeshOverlay | null) {
  const now = Date.now();
  const last = Number(el.dataset.clickAt ?? 0);
  if (now - last < 300) return;
  el.dataset.clickAt = String(now);
  overlay?.onNodeClick?.(el.dataset.id ?? "");
}

/** Düğüm öğesine tıklama / üzerine gelme dinleyicileri (handler'lar her an güncel). */
export function bindNodeEvents(
  el: HTMLElement,
  container: () => HTMLElement | null,
  current: () => MeshOverlay | null,
) {
  const id = () => el.dataset.id ?? "";
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    clickNode(el, current());
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      clickNode(el, current());
    }
  });
  el.addEventListener("pointerenter", () => {
    const box = container()?.getBoundingClientRect();
    const r = el.querySelector(".mo-body")?.getBoundingClientRect() ?? el.getBoundingClientRect();
    if (!box) return;
    current()?.onNodeHover?.(id(), { x: r.left + r.width / 2 - box.left, y: r.top - box.top });
  });
  el.addEventListener("pointerleave", () => current()?.onNodeHover?.(null, null));
}

/** Bütün düğümleri kapsayan sınırlar. */
export function boundsOf(points: LatLng[]): { sw: LatLng; ne: LatLng } | null {
  if (points.length === 0) return null;
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const p of points) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
  }
  return { sw: { lat: s, lng: w }, ne: { lat: n, lng: e } };
}
