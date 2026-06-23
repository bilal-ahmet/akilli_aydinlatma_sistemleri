import type { SystemSummary } from "@/app/_lib/types";
import { formatInt, formatKw } from "@/app/_lib/format";

interface MetricProps {
  label: string;
  value: string;
  accent?: "glow" | "muted" | "danger";
  hint?: string;
}

function Metric({ label, value, accent = "muted", hint }: MetricProps) {
  const valueColor =
    accent === "glow"
      ? "text-accent"
      : accent === "danger"
        ? "text-danger"
        : "text-text";
  return (
    <div className="rounded-2xl border border-border bg-panel p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </p>
      <p
        className={`mt-1 font-display text-2xl font-bold tabular-nums sm:text-3xl ${valueColor}`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function StatusOverview({ summary }: { summary: SystemSummary }) {
  return (
    <section aria-label="Genel durum" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric
        label="Toplam Direk"
        value={formatInt(summary.totalPoles)}
        hint={`${formatInt(summary.polesOff)} kapalı`}
      />
      <Metric label="Açık Direk" value={formatInt(summary.polesOn)} accent="glow" />
      <Metric
        label="Anlık Güç"
        value={formatKw(summary.powerKw)}
        hint="tahmini tüketim"
      />
      <Metric
        label="Arıza / Uyarı"
        value={formatInt(summary.alerts)}
        accent={summary.alerts > 0 ? "danger" : "muted"}
        hint={summary.alerts > 0 ? "ilgilenilmesi gereken bölge" : "her şey yolunda"}
      />
    </section>
  );
}
