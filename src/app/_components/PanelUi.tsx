import type { HealthTone } from "@/app/_lib/deviceHealth";
import { TONE_DOT, TONE_TEXT } from "@/app/_lib/deviceHealth";

/** Sayfa başlığı: büyük başlık + alt satır, sağda eylemler. */
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Başlığın üstündeki küçük satır (breadcrumb). */
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <div className="text-[13px] text-muted">{eyebrow}</div> : null}
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-text">{title}</h1>
        {subtitle ? <div className="text-sm text-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Metrik kartı: etiket, büyük değer (+ birim), alt satır. */
export function StatCard({
  label,
  value,
  unit,
  hint,
  valueClass = "text-text",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="stat-card flex flex-col gap-2">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="flex items-baseline gap-1">
        <span className={`text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums ${valueClass}`}>
          {value}
        </span>
        {unit ? <span className="text-base text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}
    </div>
  );
}

/** Renkli nokta + etiket (cihaz durumu). */
export function StatusLabel({ tone, label }: { tone: HealthTone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${TONE_TEXT[tone]}`}>
      <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      {label}
    </span>
  );
}

/** Artı ikonu — "+ Yeni …" düğmeleri. */
export function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Boş liste/sonuç kutusu. */
export function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border-strong bg-panel/60 px-6 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}
