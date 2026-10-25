import Link from "next/link";
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

/** Metrik kartı: etiket, büyük değer (+ birim), alt satır. `href` verilirse kart bağlantı olur. */
export function StatCard({
  label,
  value,
  unit,
  hint,
  valueClass = "text-text",
  href,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  valueClass?: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="flex items-center justify-between gap-2 text-[13px] text-muted">
        {label}
        {href ? (
          <span aria-hidden className="text-muted transition-colors group-hover:text-accent">
            ›
          </span>
        ) : null}
      </p>
      <p className="flex items-baseline gap-1">
        <span className={`text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums ${valueClass}`}>
          {value}
        </span>
        {unit ? <span className="text-base text-muted">{unit}</span> : null}
      </p>
      {hint ? <p className="text-[12.5px] text-muted">{hint}</p> : null}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="stat-card group flex flex-col gap-2 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent"
      >
        {body}
      </Link>
    );
  }
  return <div className="stat-card flex flex-col gap-2">{body}</div>;
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

/**
 * Liste altı sayfalama: "11–20 / 34 kayıt" + Önceki / Sonraki. Tek sayfaysa
 * hiç çizilmez. `page` sıfır tabanlı; çağıran sınırlar içinde tutar.
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  label,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /** Erişilebilirlik etiketi, örn. "Geçmiş arıza sayfaları". */
  label: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 border-t border-border px-[22px] py-3">
      <span className="text-[13px] text-muted">
        {from}–{to} / {total} kayıt
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
          className="btn-line h-8 px-3 text-[13px]"
        >
          ‹ Önceki
        </button>
        <span className="min-w-[52px] text-center text-[13px] tabular-nums text-ink-2">
          {page + 1} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount - 1}
          className="btn-line h-8 px-3 text-[13px]"
        >
          Sonraki ›
        </button>
      </span>
    </nav>
  );
}

/** Sayfa indeksini liste kısalınca son sayfaya çeker; o sayfanın dilimini döner. */
export function pageSlice<T>(items: T[], page: number, pageSize: number): { page: number; rows: T[] } {
  const last = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const p = Math.min(page, last);
  return { page: p, rows: items.slice(p * pageSize, (p + 1) * pageSize) };
}

/** Boş liste/sonuç kutusu. */
export function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border-strong bg-panel/60 px-6 py-10 text-center text-sm text-muted">
      {children}
    </div>
  );
}
