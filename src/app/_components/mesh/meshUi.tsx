"use client";

import type { ReactNode } from "react";
import { hex16, type MeshNode } from "@/lib/mesh/build";

/** Ağ haritası ortak küçük parçaları (yalnızca admin; teknik dil). */

export const fmt = (v: number, digits = 1) =>
  v.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const rlocText = (v: number | null) => (v === null ? "—" : hex16(v));

const timeFmt = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit" });

/** Bugünse saat, değilse "gg.aa saat". */
export function clockText(iso: string, now: number | null): string {
  const d = new Date(iso);
  const t = timeFmt.format(d);
  if (now === null) return t;
  return dayFmt.format(d) === dayFmt.format(new Date(now)) ? t : `${dayFmt.format(d)} ${t}`;
}

/** Link maliyeti tonu (tasarım: +1 iyi, +2 orta, +3 zayıf). */
export type Tone = "good" | "mid" | "bad" | "muted";
export function linkTone(cost: number | null): Tone {
  if (cost === null) return "muted";
  return cost <= 1 ? "good" : cost === 2 ? "mid" : "bad";
}

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-ok",
  mid: "text-warn",
  bad: "text-danger",
  muted: "text-muted",
};

export const STATUS_TEXT: Record<string, string> = {
  routed: "rota BR'ye ulaşıyor",
  partial: "zincir tanınmayan bir düğümde bitiyor",
  loop: "rota döngüsü",
  no_route: "cihaz rota yok bildiriyor",
  offline: "bağlantısız",
  legacy: "firmware rota bilgisi (0xCE/0xCF) göndermiyor",
};

export function nodeName(n: MeshNode | undefined): string {
  if (!n) return "—";
  return n.kind === "br" ? `BR · ${n.label}` : n.label;
}

export function NodeTag({ node }: { node: MeshNode }) {
  if (node.kind === "device" && node.status && node.status !== "routed" && node.status !== "partial") {
    const label = node.status === "offline" ? "bağlantısız" : node.status === "legacy" ? "eski firmware" : node.status === "loop" ? "döngü" : "rota yok";
    return <Tag tone="muted">{label}</Tag>;
  }
  if (node.hot) return <Tag tone="hot">darboğaz</Tag>;
  if (node.weak) return <Tag tone="bad">zayıf link</Tag>;
  if (node.status === "partial") return <Tag tone="mid">yarım rota</Tag>;
  return <Tag tone="good">sağlıklı</Tag>;
}

export function Tag({ tone, children }: { tone: "good" | "mid" | "bad" | "hot" | "sug" | "muted"; children: ReactNode }) {
  const cls = {
    good: "bg-ok-soft text-ok",
    mid: "bg-warn/15 text-warn",
    bad: "bg-danger-soft text-danger",
    hot: "bg-[#fdefdd] text-[#d26e00] dark:bg-[#33240f] dark:text-[#ff9a33]",
    sug: "bg-[#efeafe] text-[#6d4ae0] dark:bg-[#251e3d] dark:text-[#a88bff]",
    muted: "bg-track text-muted",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

/** Link kalitesi 0-3 çubukları. */
export function LqMeter({ value }: { value: number | null }) {
  const v = value ?? 0;
  const on = v <= 1 ? "bg-danger" : v === 2 ? "bg-warn" : "bg-ok";
  return (
    <span className="mr-1.5 inline-flex items-end gap-[2px] align-[-1px]" aria-hidden>
      {[1, 2, 3].map((i) => (
        <i key={i} className={`w-1 rounded-[1px] ${i <= v ? on : "bg-border"}`} style={{ height: 4 + i * 3 }} />
      ))}
    </span>
  );
}
export const lqText = (v: number | null) => (v === null ? "—" : ["yok", "zayıf", "orta", "iyi"][v] ?? String(v));

/** KPI kartındaki küçük eğri. */
export function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  const n = values.length - 1 || 1;
  const vs = pts.map((p) => p[1]);
  const mn = Math.min(...vs);
  const mx = Math.max(...vs);
  const X = (i: number) => (i / n) * 86;
  const Y = (v: number) => 28 - ((v - mn) / (mx - mn || 1)) * 24;
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox="0 0 86 30" className="h-[30px] w-[86px] overflow-visible" aria-hidden>
      <path d={`${d} L${X(last[0])} 30 L${X(pts[0][0])} 30Z`} fill={color} opacity={0.12} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} />
      <circle cx={X(last[0])} cy={Y(last[1])} r={2.4} fill={color} />
    </svg>
  );
}

/** Son 24 saat çizgi grafiği (cihaz "Ağ" sekmesi). */
export function LineChart({
  values,
  color,
  label,
  floor,
}: {
  values: (number | null)[];
  color: string;
  label: string;
  floor?: number;
}) {
  const W = 440;
  const H = 150;
  const P = 34;
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) {
    return <div className="grid h-[120px] place-items-center text-[12.5px] text-muted">Son 24 saatte yeterli kayıt yok</div>;
  }
  const vs = pts.map((p) => p[1]);
  const mn = floor ?? Math.floor(Math.min(...vs) - 2);
  const mx = Math.ceil(Math.max(...vs) + 2);
  const n = values.length - 1 || 1;
  const X = (i: number) => P + (i / n) * (W - P - 6);
  const Y = (v: number) => 10 + (1 - (v - mn) / (mx - mn || 1)) * (H - 36);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${label}, son 24 saat`}>
      {[mn, (mn + mx) / 2, mx].map((v) => (
        <g key={v}>
          <line x1={P} x2={W - 6} y1={Y(v)} y2={Y(v)} className="stroke-border" />
          <text x={P - 5} y={Y(v) + 4} textAnchor="end" className="fill-muted font-mono" fontSize={13}>
            {Math.round(v)}
          </text>
        </g>
      ))}
      {(["−24 sa", "−12 sa", "şimdi"] as const).map((t, i) => (
        <text
          key={t}
          x={X((n * i) / 2)}
          y={H - 4}
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          className="fill-muted font-mono"
          fontSize={13}
        >
          {t}
        </text>
      ))}
      <path d={`${d} L${X(last[0])} ${Y(mn)} L${X(pts[0][0])} ${Y(mn)}Z`} fill={color} opacity={0.1} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} />
      <circle cx={X(last[0])} cy={Y(last[1])} r={3.5} fill={color} />
    </svg>
  );
}

/** Başlık + sağda küçük not (tasarımdaki bölüm başlığı). */
export function SecHead({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <h4 className="mb-2.5 flex justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
      <span>{children}</span>
      {note !== undefined ? <span className="font-normal normal-case tracking-normal">{note}</span> : null}
    </h4>
  );
}

/** Etiket + alan kodu + değer satırı. */
export function Row({ label, src, children, warn }: { label: string; src?: string; children: ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2.5 text-[12.5px]">
      <span className="text-muted">
        {label}
        {src ? <span className="ml-1.5 font-mono text-[10px] text-muted/70">{src}</span> : null}
      </span>
      <b className={`font-semibold tabular-nums ${warn ? "text-danger" : "text-text"}`}>{children}</b>
    </div>
  );
}
