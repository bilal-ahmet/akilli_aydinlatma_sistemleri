"use client";

import { useEffect, useRef, useState } from "react";
import { useTechnical } from "@/app/_lib/panel";
import { PageHeader } from "../PanelUi";

/**
 * Senaryolar: sahada müşteriye sistemin farklı durumlarda (kaza, sis, yağmur,
 * gece tasarrufu) nasıl davrandığını anlatan canlandırma. YALNIZCA ANİMASYON —
 * hiçbir komut gönderilmez, API/MQTT'ye dokunulmaz.
 *
 * Simülasyon (araç takibi, kaza kuyruğu, sis/yağmur, direk başına parlaklık)
 * tek bir `requestAnimationFrame` döngüsünde çalışır; araçlar ve direkler React
 * state'i değil, DOM'a doğrudan yazılır (saniyede 60 kare re-render olmasın).
 * React'e yalnızca durum satırı metni, değiştiğinde verilir.
 */

type ScenKey = "normal" | "kaza" | "sis" | "yagmur" | "tasarruf";

interface Scenario {
  name: string;
  desc: (t: Words) => string;
  cmd: (t: Words, lv: number) => string;
  /** Senaryonun panel komutuyla ayarladığı seviye (%). Yoksa normal gece seviyesi. */
  level?: number;
  speed: number;
  spawn: number;
  fog: boolean;
  rain: boolean;
  /** Hava senaryosu: başlat/durdur düğmeleriyle yönetilir. */
  wx?: string;
  pre?: string;
  post?: string;
  stopping?: string;
}

/** Admin teknik terimleri görür, müşteri sade dil (CLAUDE.md "Dil"). */
interface Words {
  technical: boolean;
  fx: string; // "Blink" | "yanıp sönme"
}

const SCEN: Record<ScenKey, Scenario> = {
  normal: {
    name: "Normal gece",
    desc: () => "Lambalar gece seviyesinde sabit yanar, trafik normal akar.",
    cmd: (t, lv) => (t.technical ? `Panel: dim %${lv}, tüm cihazlar` : `Panel komutu: şiddet %${lv}, tüm lambalar`),
    speed: 1,
    spawn: 1,
    fog: false,
    rain: false,
  },
  kaza: {
    name: "Kaza",
    desc: (t) =>
      `"Kaza yap"a basınca kaza olur, tüm direkler aynı anda ${
        t.technical ? "Blink efektiyle yanıp söner" : "yanıp söner"
      }. Arkadaki trafik kuyruk olur, karşı şerit yavaşlar. "Kazayı düzelt"e basınca kazalı araçlar kalkar; trafik açılınca ${
        t.technical ? "Blink" : "yanıp sönme"
      } durur ve lambalar eski seviyeye döner.`,
    cmd: (t, lv) =>
      t.technical
        ? `Panel: efekt 2 (Blink), tüm cihazlar  →  bitince: efekti durdur (dim %${lv})`
        : `Panel komutu: yanıp sönme efekti, tüm lambalar  →  bitince: lambalar %${lv} şiddete döner`,
    speed: 1,
    spawn: 1,
    fog: false,
    rain: false,
  },
  sis: {
    name: "Sis",
    desc: () =>
      '"Sis başlat"a basınca sis basar, yol ve araçlar zor görünür. Panel komutuyla lambalar anında tam parlaklığa çıkar ve sabit kalır (yanıp sönme yok). "Sis durdur"a basınca sis dağılır, açılınca lambalar eski seviyeye döner.',
    cmd: (t, lv) =>
      t.technical
        ? `Panel: dim %100, tüm cihazlar  →  bitince: dim %${lv}`
        : `Panel komutu: şiddet %100, tüm lambalar  →  bitince: şiddet %${lv}`,
    level: 100,
    speed: 0.5,
    spawn: 1.3,
    fog: true,
    rain: false,
    wx: "Sis",
    pre: "Sis bastırıyor, görüş düşük",
    post: "Lambalar %100, yol yeniden görünüyor",
    stopping: "Sis dağılıyor",
  },
  yagmur: {
    name: "Yağmur",
    desc: () =>
      '"Yağmur başlat"a basınca yağmur başlar, ıslak yolda görüş azalır. Panel komutuyla lambalar %80 seviyesine çıkar, araçlar biraz yavaşlar. "Yağmur durdur"a basınca yağmur diner, lambalar eski seviyeye döner.',
    cmd: (t, lv) =>
      t.technical
        ? `Panel: dim %80, tüm cihazlar  →  bitince: dim %${lv}`
        : `Panel komutu: şiddet %80, tüm lambalar  →  bitince: şiddet %${lv}`,
    level: 80,
    speed: 0.7,
    spawn: 1.1,
    fog: false,
    rain: true,
    wx: "Yağmur",
    pre: "Yağmur başladı",
    post: "Lambalar %80",
    stopping: "Yağmur diniyor",
  },
  tasarruf: {
    name: "Gece tasarrufu",
    desc: () =>
      "Gece yarısından sonra lambalar %20 seviyesinde bekler. Araç yaklaşınca o direkler hızla %100 olur, araç geçince yavaşça tekrar %20'ye iner. (Her direkte araç algılayan sensör olduğu varsayıldı.)",
    cmd: () => "Bekleme: %20  →  araç algılanınca: o direk %100  →  araç geçince: yavaşça %20",
    level: 20,
    speed: 1,
    spawn: 2.2,
    fog: false,
    rain: false,
    pre: "Saat 00:00, trafik azalıyor",
  },
};

const SCEN_KEYS = Object.keys(SCEN) as ScenKey[];

const N = 9;
const POLE_INDEXES = Array.from({ length: N }, (_, i) => i);
const COLORS = ["#378ADD", "#1D9E75", "#888780", "#7F77DD", "#BA7517"];
const VMAX = 110;
const LEN = 30;
/** Panel komutunun "gönderilip" lambalara yansıması için bekleme (canlandırma). */
const CMD_MS = 3000;

interface Car {
  lane: 0 | 1;
  s: number;
  v: number;
  el: HTMLDivElement;
  crashed: boolean;
  distracted: boolean;
}

interface Engine {
  setScen: (k: ScenKey) => void;
  crash: () => void;
  fix: () => void;
  wxStart: () => void;
  wxStop: () => void;
}

interface PoleEls {
  root: HTMLDivElement | null;
  halo: HTMLDivElement | null;
  glow: HTMLDivElement | null;
  lens: HTMLDivElement | null;
  beam: HTMLDivElement | null;
  pool: HTMLDivElement | null;
}

/**
 * Görünen parlaklık hedefe yumuşakça yaklaşır (DALI sürücüsünün fade'i gibi):
 * açılış hızlı, sönüş daha yavaş. Yanıp sönme böylece sert kare dalga yerine
 * parlayıp sönen bir ışık olur.
 */
const RISE = 18;
const FALL = 7;

const chip = (active: boolean) =>
  `inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full px-3.5 text-[13px] transition-colors duration-150 ${
    active
      ? "border border-text bg-text font-medium text-bg hover:bg-text/85"
      : "border border-border bg-panel text-ink-2 hover:border-glow/50 hover:bg-glow/10 hover:text-text"
  }`;

export function ScenariosView() {
  const technical = useTechnical();
  const words: Words = { technical, fx: technical ? "Blink" : "yanıp sönme" };

  const [scen, setScenState] = useState<ScenKey>("normal");
  const [level, setLevelState] = useState(40);
  const [status, setStatus] = useState("");

  const levelRef = useRef(40);
  const wordsRef = useRef<Words>(words);
  const engineRef = useRef<Engine | null>(null);
  const roadRef = useRef<HTMLDivElement>(null);
  const boomRef = useRef<HTMLDivElement>(null);
  const fogRef = useRef<HTMLDivElement>(null);
  const rainRef = useRef<HTMLDivElement>(null);
  const poleRefs = useRef<PoleEls[]>(
    Array.from({ length: N }, () => ({ root: null, halo: null, glow: null, lens: null, beam: null, pool: null })),
  );

  useEffect(() => {
    wordsRef.current = { technical, fx: technical ? "Blink" : "yanıp sönme" };
  }, [technical]);

  useEffect(() => {
    const road = roadRef.current;
    const boom = boomRef.current;
    const fogEl = fogRef.current;
    const rainEl = rainRef.current;
    if (!road || !boom || !fogEl || !rainEl) return;
    const poles = poleRefs.current;

    const s = {
      cars: [] as Car[],
      scen: "normal" as ScenKey,
      crashT: 0,
      spawnT: [0, 0.6],
      restoreT: -1e9,
      prevName: "",
      scenT: 0,
      fogNow: 0,
      rainNow: 0,
      crashPending: false,
      crashActive: false,
      crashedOnce: false,
      clearing: false,
      fixT: 0,
      wxOn: false,
      wxStopping: false,
      wxStarted: false,
      wxCmdDone: false,
      wxT: 0,
      wxOffT: 0,
      poleB: new Array<number>(N).fill(0.4),
      /** Ekrandaki (yumuşatılmış) parlaklık. */
      disp: new Array<number>(N).fill(0.4),
    };
    let last = performance.now();
    let lastStatus = "";
    let raf = 0;

    const lv = () => levelRef.current;
    const wxActive = () => s.wxOn || s.wxStopping;
    const spd = () => {
      const S = SCEN[s.scen];
      return S.wx && !wxActive() ? 1 : S.speed;
    };
    const leader = (c: Car) => {
      let best: Car | null = null;
      for (const o of s.cars) {
        if (o !== c && o.lane === c.lane && o.s > c.s && (!best || o.s < best.s)) best = o;
      }
      return best;
    };
    const mk = (lane: 0 | 1): Car => {
      const el = document.createElement("div");
      el.style.cssText = `position:absolute;width:${LEN}px;height:14px;border-radius:4px;top:${lane === 0 ? 40 : 10}px;background:${
        COLORS[Math.floor(Math.random() * COLORS.length)]
      }`;
      // Farlar: gidiş yönünde sönen kısa ışık, arkada kırmızı stop lambaları.
      const front = lane === 0 ? "left:100%" : "right:100%";
      const dir = lane === 0 ? "to right" : "to left";
      const tail = lane === 0 ? "left:0" : "right:0";
      el.innerHTML =
        `<div style="position:absolute;${front};top:-2px;width:34px;height:18px;pointer-events:none;` +
        `background:linear-gradient(${dir},rgba(255,244,214,.42),rgba(255,244,214,0));` +
        `clip-path:polygon(${lane === 0 ? "0 38%,100% 0,100% 100%,0 62%" : "0 0,100% 38%,100% 62%,0 100%"})"></div>` +
        `<div style="position:absolute;${tail};top:2px;width:2px;height:3px;border-radius:1px;background:#ff4d3d;box-shadow:0 0 4px #ff4d3d"></div>` +
        `<div style="position:absolute;${tail};bottom:2px;width:2px;height:3px;border-radius:1px;background:#ff4d3d;box-shadow:0 0 4px #ff4d3d"></div>`;
      road.appendChild(el);
      return { lane, s: -LEN, v: VMAX * spd() * (0.8 + Math.random() * 0.2), el, crashed: false, distracted: false };
    };

    function startCrash(now: number): boolean {
      const w = road!.clientWidth;
      const lane0 = s.cars.filter((c) => c.lane === 0);
      const cand =
        lane0.filter((c) => c.s > w * 0.4 && c.s < w * 0.7).sort((a, b) => b.s - a.s)[0] ??
        lane0.sort((a, b) => b.s - a.s)[0];
      if (!cand) return false;
      cand.crashed = true;
      cand.v = 0;
      cand.el.style.background = "#E24B4A";
      let f: Car | null = null;
      for (const o of s.cars) if (o.lane === 0 && o.s < cand.s && (!f || o.s > f.s)) f = o;
      if (f) f.distracted = true;
      boom!.style.left = `${cand.s - 10}px`;
      boom!.style.display = "block";
      s.crashT = now;
      s.crashActive = true;
      return true;
    }

    function clearCrash() {
      for (const c of s.cars) if (c.crashed) c.el.remove();
      s.cars = s.cars.filter((c) => !c.crashed);
      for (const c of s.cars) c.distracted = false;
      boom!.style.display = "none";
      s.crashActive = false;
      s.crashPending = false;
      s.clearing = false;
    }

    function statusText(now: number, S: Scenario, b: number, cmdSent: boolean): string {
      const w = wordsRef.current;
      const L = lv();
      if (s.scen === "kaza") {
        if (s.crashActive) {
          const q = s.cars.filter((c) => c.lane === 0 && !c.crashed && c.v < 8).length;
          return `Kaza: tüm direkler aynı anda ${w.technical ? "Blink" : "yanıp sönüyor"}, kuyrukta ${q} araç`;
        }
        if (s.clearing) {
          const q = s.cars.filter((c) => c.lane === 0 && c.v < 60).length;
          return `Kazalı araçlar kaldırıldı, trafik açılıyor (${q} araç hâlâ yavaş). Lambalar hâlâ ${
            w.technical ? "Blink'te" : "yanıp sönüyor"
          }`;
        }
        if (s.crashPending) return "Kaza bekleniyor…";
        if (s.crashedOnce) return `Trafik açıldı: ${w.fx} durdu, lambalar eski seviyede (%${L})`;
        return `Trafik normal, lambalar %${L}. "Kaza yap"a basın.`;
      }
      if (S.wx) {
        if (s.wxOn && !cmdSent) return `${S.pre} (lambalar hâlâ %${L})`;
        if (s.wxOn) return S.post ?? "";
        if (s.wxStopping) return `${S.stopping}, lambalar hâlâ %${Math.round(b * 100)}`;
        if (s.wxStarted) return `Hava açıldı: lambalar eski seviyede (%${L})`;
        return `Hava açık, lambalar %${L}. "${S.wx} başlat"a basın.`;
      }
      if (S.level !== undefined && !cmdSent) return `${S.pre} (lambalar hâlâ %${Math.round(b * 100)})`;
      if (s.scen === "tasarruf") {
        const k = s.poleB.filter((x) => x > 0.6).length;
        return k ? `Araç geçiyor: ${k} direk açık, diğerleri %20` : "Yol boş, tüm lambalar %20";
      }
      if (now - s.restoreT < 2500 && s.prevName) return `${s.prevName} bitti, lambalar eski seviyeye (%${L}) dönüyor`;
      return `Lambalar %${Math.round(b * 100)}`;
    }

    function step(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const w = road!.clientWidth;
      const S = SCEN[s.scen];

      if (s.crashPending && startCrash(now)) s.crashPending = false;
      if (s.clearing) {
        const slow = s.cars.some((c) => c.lane === 0 && c.v < 60);
        if ((now - s.fixT > 2000 && !slow) || now - s.fixT > 12000) s.clearing = false;
      }

      // Araç üretimi (şerit başına)
      for (const l of [0, 1] as const) {
        s.spawnT[l] -= dt;
        if (s.spawnT[l] <= 0) {
          const blocked = s.cars.some((c) => c.lane === l && c.s < LEN + 12);
          if (!blocked) s.cars.push(mk(l));
          s.spawnT[l] = (0.9 + Math.random() * 1.4) * (S.wx && !wxActive() ? 1 : S.spawn);
        }
      }

      // Araç hareketi: öndeki araçla mesafe, kaza yerinde karşı şerit yavaşlar
      const cx = w * 0.58;
      for (const c of s.cars) {
        if (c.crashed) {
          c.v = 0;
          continue;
        }
        const ld = leader(c);
        const gap = ld ? ld.s - c.s - LEN : 1e9;
        let vmax = VMAX * spd();
        if (s.crashActive && c.lane === 1) {
          const x = w - c.s;
          if (Math.abs(x - cx) < w * 0.22) vmax = VMAX * 0.35;
        }
        const target = c.distracted ? vmax : Math.max(0, Math.min(vmax, (gap - 10) * 2.2));
        c.v += (target - c.v) * Math.min(1, dt * (target < c.v ? 5 : 1.5));
        if (c.distracted && ld && gap <= 1) {
          c.crashed = true;
          c.v = 0;
          c.distracted = false;
          c.el.style.background = "#E24B4A";
        }
        c.s += c.v * dt;
      }
      s.cars = s.cars.filter((c) => {
        if (c.s > w + LEN + 10) {
          c.el.remove();
          return false;
        }
        return true;
      });
      for (const c of s.cars) c.el.style.left = `${c.lane === 0 ? c.s : w - c.s - LEN}px`;

      // Panel komutu "gönderildi" mi?
      let cmdSent: boolean;
      if (S.wx) {
        cmdSent = s.wxOn && now - s.wxT > CMD_MS;
        if (cmdSent) s.wxCmdDone = true;
      } else cmdSent = S.level === undefined || now - s.scenT > CMD_MS;
      if (s.wxStopping && ((S.fog && s.fogNow < 0.08) || (S.rain && now - s.wxOffT > 1500))) {
        s.wxStopping = false;
        s.wxCmdDone = false;
      }

      // Genel parlaklık
      let b: number;
      if (s.scen === "kaza" && (s.crashActive || s.clearing)) b = Math.floor((now - s.crashT) / 450) % 2 === 0 ? 1 : 0;
      else if (S.wx) b = ((cmdSent || (s.wxStopping && s.wxCmdDone) ? S.level! : lv()) / 100);
      else b = (cmdSent && S.level !== undefined ? S.level : lv()) / 100;

      // Sis / yağmur katmanları
      const fogGoal = S.fog && s.wxOn ? (cmdSent ? 0.45 : 0.8) : 0;
      s.fogNow += (fogGoal - s.fogNow) * Math.min(1, dt * 1.2);
      fogEl!.style.opacity = s.fogNow.toFixed(2);
      const rainGoal = S.rain && s.wxOn ? 0.9 : 0;
      s.rainNow += (rainGoal - s.rainNow) * Math.min(1, dt * 2);
      rainEl!.style.opacity = s.rainNow.toFixed(2);

      // Direkler
      const rr = s.scen === "tasarruf" && cmdSent ? road!.getBoundingClientRect() : null;
      for (let i = 0; i < N; i++) {
        const p = poles[i];
        let pb = b;
        if (rr && p.root) {
          const r = p.root.getBoundingClientRect();
          const px = r.left + r.width / 2 - rr.left;
          const near = s.cars.some((c) => {
            const carX = c.lane === 0 ? c.s + LEN / 2 : w - c.s - LEN / 2;
            return Math.abs(carX - px) < r.width * 1.3;
          });
          const goal = near ? 1 : S.level! / 100;
          s.poleB[i] += (goal - s.poleB[i]) * Math.min(1, dt * (goal > s.poleB[i] ? 4 : 0.5));
          pb = s.poleB[i];
        } else s.poleB[i] = pb;

        const d = s.disp[i];
        s.disp[i] = d + (pb - d) * Math.min(1, dt * (pb > d ? RISE : FALL));
        const v = s.disp[i];
        if (p.beam) p.beam.style.opacity = (0.02 + 0.98 * Math.pow(v, 0.85)).toFixed(3);
        if (p.pool) p.pool.style.opacity = (0.9 * Math.pow(v, 0.9)).toFixed(3);
        if (p.glow) p.glow.style.opacity = v.toFixed(3);
        if (p.lens) p.lens.style.opacity = (0.18 + 0.82 * v).toFixed(3);
        if (p.halo) {
          p.halo.style.opacity = (
            s.fogNow > 0.05 ? Math.max(0, v - 0.25) * Math.min(1, s.fogNow * 1.5) : 0
          ).toFixed(3);
        }
      }

      const text = statusText(now, S, b, cmdSent);
      if (text !== lastStatus) {
        lastStatus = text;
        setStatus(text);
      }
      raf = requestAnimationFrame(step);
    }

    engineRef.current = {
      setScen(k) {
        if (k === s.scen && k !== "kaza") return;
        if (s.scen === "kaza") clearCrash();
        s.prevName = SCEN[s.scen].name;
        s.restoreT = performance.now();
        s.scenT = s.restoreT;
        s.scen = k;
        s.crashedOnce = false;
        s.wxOn = false;
        s.wxStopping = false;
        s.wxStarted = false;
        s.wxCmdDone = false;
      },
      crash() {
        if (s.scen !== "kaza" || s.crashActive || s.crashPending) return;
        s.clearing = false;
        s.crashedOnce = true;
        s.crashPending = !startCrash(performance.now());
      },
      fix() {
        if (s.crashActive) {
          clearCrash();
          s.clearing = true;
          s.fixT = performance.now();
        } else if (s.crashPending) clearCrash();
      },
      wxStart() {
        if (s.wxOn) return;
        s.wxOn = true;
        s.wxStopping = false;
        s.wxStarted = true;
        s.wxCmdDone = false;
        s.wxT = performance.now();
      },
      wxStop() {
        if (!s.wxOn) return;
        s.wxOn = false;
        s.wxStopping = true;
        s.wxOffT = performance.now();
      },
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      for (const c of s.cars) c.el.remove();
      engineRef.current = null;
    };
  }, []);

  const S = SCEN[scen];

  function pick(k: ScenKey) {
    setScenState(k);
    engineRef.current?.setScen(k);
  }

  function changeLevel(v: number) {
    const next = Math.min(100, Math.max(10, v));
    levelRef.current = next;
    setLevelState(next);
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-[22px]">
      <PageHeader
        title="Senaryolar"
        subtitle="Sistemin farklı durumlarda nasıl davrandığını gösteren canlandırma. Gerçek lambalara komut gitmez."
      />

      <section className="flex flex-col gap-4 rounded-2xl border border-border bg-panel px-5 py-[18px]">
        <div role="group" aria-label="Senaryo" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0">
          {SCEN_KEYS.map((k) => (
            <button key={k} type="button" aria-pressed={k === scen} onClick={() => pick(k)} className={chip(k === scen)}>
              {SCEN[k].name}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-1.5 rounded-xl bg-panel-2 px-4 py-3">
          <p className="text-sm leading-relaxed text-text">{S.desc(words)}</p>
          <p className="font-mono text-[12.5px] leading-snug text-muted">{S.cmd(words, level)}</p>
        </div>

        <label className="flex flex-wrap items-center gap-3 text-[13px] text-ink-2">
          <span className="shrink-0">Normal gece seviyesi</span>
          <input
            type="range"
            min={10}
            max={100}
            step={1}
            value={level}
            onChange={(e) => changeLevel(Number(e.target.value))}
            aria-valuetext={`%${level}`}
            style={{ "--pct": `${((level - 10) / 90) * 100}%` } as React.CSSProperties}
            className="brightness-range h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-transparent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-glow"
          />
          <span className="w-11 font-mono text-sm tabular-nums text-accent">%{level}</span>
        </label>
      </section>

      <section aria-label="Canlandırma" className="flex flex-col gap-3">
        <p aria-live="polite" className="min-h-[22px] text-sm text-muted">
          {status}
        </p>

        {/* Sahne her temada gece (koyu) kalır; renkler sabit hex. */}
        <div
          className="relative overflow-hidden rounded-2xl bg-[linear-gradient(to_bottom,#0d1120,#161821_55%,#1c1c1b)] px-2 pt-4"
          aria-hidden
        >
          <div className="relative z-[3] flex items-end justify-between gap-1 px-1">
            {POLE_INDEXES.map((i) => (
              <div
                key={i}
                ref={(el) => {
                  poleRefs.current[i].root = el;
                }}
                className="relative h-[150px] flex-1"
              >
                {/* Direk gövdesi + yola uzanan kol */}
                <div className="absolute bottom-0 left-[calc(50%-min(22px,36%))] h-[142px] w-[4px] rounded-t-sm bg-[linear-gradient(90deg,#4a4945,#7d7c75_45%,#3a3936)]" />
                <div className="absolute left-[calc(50%-min(22px,36%))] top-[7px] h-[3px] w-[min(24px,38%)] rounded-full bg-[#696862]" />

                {/* Hüzme: dış katman bulanıklaştırır (yumuşak kenar), iç katman kırpar */}
                <div
                  ref={(el) => {
                    poleRefs.current[i].beam = el;
                  }}
                  className="pointer-events-none absolute left-1/2 top-[13px] h-[137px] w-[160%] -translate-x-1/2 blur-[6px]"
                >
                  <div className="h-full w-full bg-[linear-gradient(to_bottom,rgba(255,232,186,.72),rgba(255,206,132,.30)_45%,rgba(255,186,96,.08)_85%,rgba(255,186,96,0))] [clip-path:polygon(45%_0,55%_0,94%_100%,6%_100%)]" />
                </div>

                {/* Sisteki ışık halesi */}
                <div
                  ref={(el) => {
                    poleRefs.current[i].halo = el;
                  }}
                  className="pointer-events-none absolute left-1/2 top-[-18px] h-[70px] w-[120px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,224,170,.85),rgba(255,206,140,.25)_45%,rgba(255,200,120,0)_70%)] opacity-0"
                />

                {/* Armatür etrafındaki ışıma */}
                <div
                  ref={(el) => {
                    poleRefs.current[i].glow = el;
                  }}
                  className="pointer-events-none absolute left-1/2 top-[-4px] h-[36px] w-[64px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,236,196,.75),rgba(255,206,140,.18)_50%,rgba(255,200,120,0)_72%)]"
                />

                {/* Armatür gövdesi + ışık veren alt yüzey */}
                <div className="absolute left-1/2 top-[5px] h-[8px] w-[30px] -translate-x-1/2 rounded-t-[7px] rounded-b-[2px] bg-[linear-gradient(to_bottom,#4b4a46,#2b2a27)]" />
                <div
                  ref={(el) => {
                    poleRefs.current[i].lens = el;
                  }}
                  className="absolute left-1/2 top-[12px] h-[3px] w-[22px] -translate-x-1/2 rounded-full bg-[#fff4dc] shadow-[0_0_6px_2px_rgba(255,220,150,.85),0_0_14px_4px_rgba(255,196,110,.45)]"
                />

                {/* Yolda direğin altına düşen ışık */}
                <div
                  ref={(el) => {
                    poleRefs.current[i].pool = el;
                  }}
                  className="pointer-events-none absolute left-1/2 top-full h-[60px] w-[130%] -translate-x-1/2 bg-[radial-gradient(ellipse_50%_75%_at_50%_10%,rgba(255,220,160,.5),rgba(255,200,120,.16)_50%,rgba(255,190,100,0)_100%)]"
                />
              </div>
            ))}
          </div>
          <div ref={roadRef} className="relative z-[1] -mx-2 h-16 overflow-hidden bg-[linear-gradient(to_bottom,#3f3f3c,#353532)]">
            <div className="absolute inset-x-0 top-[31px] border-t-2 border-dashed border-[#7d7c75]/80" />
            <div
              ref={boomRef}
              className="absolute top-[22px] z-[5] hidden h-5 w-5 rounded-full border-2 border-white bg-[#E24B4A] text-center text-sm font-bold leading-4 text-white"
            >
              !
            </div>
          </div>
          <div
            ref={fogRef}
            className="pointer-events-none absolute inset-0 z-[2] bg-[linear-gradient(to_bottom,rgba(150,149,142,.75),#8f8e87)] opacity-0"
          />
          <div ref={rainRef} className="scenario-rain pointer-events-none absolute inset-0 z-[2] opacity-0" />
        </div>

        {scen === "kaza" ? (
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => engineRef.current?.crash()}
              className="inline-flex h-11 items-center justify-center rounded-[10px] bg-danger px-6 text-[15px] font-semibold text-white transition-[filter] hover:brightness-105"
            >
              Kaza yap
            </button>
            <button type="button" onClick={() => engineRef.current?.fix()} className="btn-glow h-11 px-6 text-[15px]">
              Kazayı düzelt
            </button>
          </div>
        ) : null}
        {S.wx ? (
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button type="button" onClick={() => engineRef.current?.wxStart()} className="btn-glow h-11 px-6 text-[15px]">
              {S.wx} başlat
            </button>
            <button type="button" onClick={() => engineRef.current?.wxStop()} className="btn-line h-11 px-6 text-[15px]">
              {S.wx} durdur
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
