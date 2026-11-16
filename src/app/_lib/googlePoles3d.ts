import * as THREE from "three";
import type { MapPole } from "@/app/_components/PoleMap";
import { poleHeadColors } from "./poleColors";

/**
 * Google haritasında 3B direkler — `WebGLOverlayView` + three.js.
 *
 * Bütün direkler parça başına tek `InstancedMesh` ile çizilir (direk sayısı
 * ne olursa olsun birkaç çizim çağrısı). Gerçek ölçüde (≈10 m) direk haritada
 * birkaç piksel kalırdı; bu yüzden modeller yakınlaşmaya göre ölçeklenir ve
 * ekranda yaklaşık sabit boyda durur (MapLibre sürümüyle aynı kural).
 *
 * Konumlar bir çıpa noktasına göre metre ötelemesidir (Mercator; Google'ın
 * `fromLatLngAltitude` matrisiyle aynı dünya). Çıpa harita merkezinden
 * uzaklaşınca yenilenir — tek çıpa onlarca km ötede metrelerce kayardı.
 *
 * Bu modül three.js'i taşıdığı için yalnızca 3B görünüm ilk açıldığında
 * dinamik yüklenir.
 */

/** Direklerin 3B çizildiği en küçük yakınlaşma (Google zoom'u). */
const MIN_ZOOM = 15.5;
const POLE_HEIGHT_M = 9.8;
/** Direğin ekrandaki yaklaşık boyu (eğimsiz bakışta, piksel). */
const POLE_SCREEN_PX = 96;
const EARTH_RADIUS = 6_371_010;
const REANCHOR_M = 1500;

export interface Poles3d {
  setPoles(poles: MapPole[], dark: boolean): void;
  setVisible(visible: boolean): void;
}

function poleScale(zoom: number, lat: number): number {
  const metersPerPx = (156_543.034 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  return Math.min(40, Math.max(1.5, (POLE_SCREEN_PX * metersPerPx) / POLE_HEIGHT_M));
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));

/** Çıpaya göre (doğu, kuzey) metre. */
function offset(lat: number, lng: number, lat0: number, lng0: number): [number, number] {
  const k = EARTH_RADIUS * Math.cos(rad(lat0));
  return [k * rad(lng - lng0), k * (mercY(lat) - mercY(lat0))];
}

/** Dikey (Z yukarı) silindir: three.js silindiri Y ekseninde üretir. */
function upright(rTop: number, rBottom: number, z0: number, z1: number, seg = 14): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, z1 - z0, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}

/** Yere düşen ışık: ortadan kenara sönen daire dokusu. */
function glowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,214,110,0.85)");
  grad.addColorStop(0.45, "rgba(255,201,77,0.35)");
  grad.addColorStop(1, "rgba(255,201,77,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Part {
  mesh: THREE.InstancedMesh;
  /** Duruma göre örnek rengi. */
  tint?: "head" | "lens";
  /** Yalnızca yanan direkte görünür. */
  onlyOn?: boolean;
}

function create(map: google.maps.Map): Poles3d {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 2.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(-0.5, -0.9, 1.4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera();
  let renderer: THREE.WebGLRenderer | null = null;

  let poles: MapPole[] = [];
  let dark = false;
  let visible = false;
  let parts: Part[] = [];
  let anchor: { lat: number; lng: number } | null = null;
  let positions: Float32Array = new Float32Array(0);
  let scale = 0;

  const glowTex = glowTexture();
  const tmp = new THREE.Matrix4();
  const color = new THREE.Color();

  function dispose() {
    for (const p of parts) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    parts = [];
  }

  /** Direk modeli: kaide, incelen gövde, kavisli konsol, armatür, ışık yüzeyi, yer ışığı. */
  function build() {
    dispose();
    const n = poles.length;
    if (n === 0) return;
    const steel = new THREE.MeshLambertMaterial({ color: dark ? 0xc9c4ba : 0x55514b });
    const steelDark = new THREE.MeshLambertMaterial({ color: dark ? 0x8f8a80 : 0x2f2d2a });
    const arm = new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 8.85),
        new THREE.Vector3(0.45, 0, 9.45),
        new THREE.Vector3(1.3, 0, 9.7),
        new THREE.Vector3(2.35, 0, 9.6),
      ]),
      20,
      0.1,
      10,
    );
    const head = new THREE.BoxGeometry(1.7, 0.66, 0.24);
    head.translate(2.95, 0, 9.52);
    const lens = new THREE.BoxGeometry(1.35, 0.46, 0.07);
    lens.translate(2.98, 0, 9.37);
    const glow = new THREE.PlaneGeometry(13, 13);
    glow.translate(2.4, 0, 0.08);

    const defs: Array<Omit<Part, "mesh"> & { geo: THREE.BufferGeometry; mat: THREE.Material }> = [
      { geo: upright(0.5, 0.5, 0, 0.22, 16), mat: steelDark.clone() },
      { geo: upright(0.3, 0.38, 0.22, 1.2), mat: steelDark },
      { geo: upright(0.13, 0.23, 1.2, 9), mat: steel },
      { geo: arm, mat: steel.clone() },
      { geo: head, mat: new THREE.MeshLambertMaterial({ color: 0xffffff }), tint: "head" },
      { geo: lens, mat: new THREE.MeshBasicMaterial({ color: 0xffffff }), tint: "lens" },
      {
        geo: glow,
        mat: new THREE.MeshBasicMaterial({
          map: glowTex,
          transparent: true,
          depthWrite: false,
          opacity: dark ? 0.9 : 0.7,
        }),
        onlyOn: true,
      },
    ];
    parts = defs.map(({ geo, mat, tint, onlyOn }) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      // Kamera matrisi Google'dan geliyor; three.js'in görüş kesmesi yanlış eler.
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { mesh, tint, onlyOn };
    });
    for (const part of parts) {
      if (!part.tint) continue;
      poles.forEach((p, i) => {
        part.mesh.setColorAt(i, color.set(poleHeadColors(p.state, dark)[part.tint!]));
      });
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    anchor = null;
    scale = 0;
  }

  function reanchor(lat: number, lng: number) {
    anchor = { lat, lng };
    positions = new Float32Array(poles.length * 2);
    poles.forEach((p, i) => {
      const [x, y] = offset(p.lat, p.lng, lat, lng);
      positions[i * 2] = x;
      positions[i * 2 + 1] = y;
    });
    scale = 0;
  }

  function place(s: number) {
    scale = s;
    for (const part of parts) {
      poles.forEach((p, i) => {
        const k = part.onlyOn && p.state !== "on" ? 0 : s;
        tmp.makeScale(k, k, k).setPosition(positions[i * 2], positions[i * 2 + 1], 0);
        part.mesh.setMatrixAt(i, tmp);
      });
      part.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  const overlay = new google.maps.WebGLOverlayView();
  overlay.onContextRestored = ({ gl }) => {
    renderer = new THREE.WebGLRenderer({ canvas: gl.canvas, context: gl, ...gl.getContextAttributes() });
    renderer.autoClear = false;
  };
  overlay.onContextLost = () => {
    renderer?.dispose();
    renderer = null;
  };
  overlay.onDraw = ({ transformer }) => {
    if (!renderer || !visible || parts.length === 0) return;
    const zoom = map.getZoom() ?? 0;
    const center = map.getCenter();
    if (zoom < MIN_ZOOM || !center) return;
    const lat = center.lat();
    const lng = center.lng();
    if (!anchor) {
      reanchor(lat, lng);
    } else {
      const [dx, dy] = offset(lat, lng, anchor.lat, anchor.lng);
      if (Math.hypot(dx, dy) > REANCHOR_M) reanchor(lat, lng);
    }
    // Ölçek 0,1'lik zoom adımlarıyla yenilenir (her karede binlerce matris yazılmasın).
    const s = poleScale(Math.round(zoom * 10) / 10, anchor!.lat);
    if (s !== scale) place(s);
    camera.projectionMatrix.fromArray(
      transformer.fromLatLngAltitude({ lat: anchor!.lat, lng: anchor!.lng, altitude: 0 }),
    );
    renderer.render(scene, camera);
    // Bağlam Google ile ortak: three.js'in bıraktığı GL durumu sıfırlanmalı.
    renderer.resetState();
  };
  overlay.setMap(map);

  return {
    setPoles(next, isDark) {
      poles = next;
      dark = isDark;
      build();
      overlay.requestRedraw();
    },
    setVisible(v) {
      visible = v;
      overlay.requestRedraw();
    },
  };
}

const layers = new WeakMap<google.maps.Map, Poles3d>();

/** Haritanın 3B direk katmanı (harita başına tek; ilk çağrıda kurulur). */
export function getPoles3d(map: google.maps.Map): Poles3d {
  let layer = layers.get(map);
  if (!layer) {
    layer = create(map);
    layers.set(map, layer);
  }
  return layer;
}
