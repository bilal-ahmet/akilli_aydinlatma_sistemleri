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

/** Alacakaranlık → şafak: gece boyunca planlı yanma penceresi. */
function DuskToDawnTimeline() {
  // Şehir takvimine göre yaklaşık: 19:40 yanış, 06:15 sönüş.
  const onAt = 19 + 40 / 60;
  const offAt = 6 + 15 / 60;
  const nowHour = new Date().getHours() + new Date().getMinutes() / 60;

  // Gece penceresi içindeysek konumu hesapla (sarımsı şerit yüzdesi).
  const inWindow = nowHour >= onAt || nowHour < offAt;
  const elapsed =
    nowHour >= onAt ? nowHour - onAt : 24 - onAt + nowHour;
  const total = 24 - onAt + offAt;
  const nowPct = Math.min(100, Math.max(0, (elapsed / total) * 100));

  return (
    <div className="rounded-2xl border border-border bg-panel p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          Alacakaranlık → Şafak
        </p>
        <p className="font-mono text-[11px] text-muted">
          19:40 — 06:15
        </p>
      </div>
      <div className="relative mt-4 h-2 rounded-full bg-gradient-to-r from-glow/70 via-glow-soft/40 to-glow/70">
        {inWindow ? (
          <span
            className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-glow ring-2 ring-panel shadow-[0_0_12px_var(--glow)]"
            style={{ left: `${nowPct}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>Akşam</span>
        <span>Gece yarısı</span>
        <span>Sabah</span>
      </div>
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
        hint={summary.alerts > 0 ? "ilgilenilmesi gereken zon" : "her şey yolunda"}
      />
      <div className="sm:col-span-2 lg:col-span-4">
        <DuskToDawnTimeline />
      </div>
    </section>
  );
}
