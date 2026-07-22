import type { LiveSummary, SystemSummary } from "@/app/_lib/types";
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

const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Watt'ı okunur birime çevirir: 1 kW altı W, üstü kW. */
function formatPower(watts: number): string {
  return watts >= 1000 ? formatKw(watts / 1000) : `${tr1.format(watts)} W`;
}

/** "12 lambadan ölçüldü" — sayaçlar metrik başınadır (D4i'siz sürücü sayılmaz). */
function lampHint(lamps: number, suffix = "lambadan ölçüldü"): string {
  return `${formatInt(lamps)} ${suffix}`;
}

/** Ölçüm gelmemiş metrikler için ortak boş gösterim. */
const EMPTY = "—";
const EMPTY_HINT = "cihaz henüz bildirmedi";

export function StatusOverview({
  summary,
  live,
}: {
  summary: SystemSummary;
  /** Ölçülmüş değerler; henüz yüklenmediyse null (tahmine düşülür). */
  live: LiveSummary | null;
}) {
  const faults = live ? live.faultyLamps : summary.alerts;

  return (
    <section
      aria-label="Genel durum"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      <Metric
        label="Toplam Direk"
        value={formatInt(summary.totalPoles)}
        hint={`${formatInt(summary.polesOff)} kapalı`}
      />
      <Metric label="Açık Direk" value={formatInt(summary.polesOn)} accent="glow" />

      {/* Şebekeden çekilen güç — ölçüm yoksa direk sayısından tahmine düşer. */}
      <Metric
        label="Çekilen Güç"
        value={
          live?.powerW != null ? formatPower(live.powerW) : formatKw(summary.powerKw)
        }
        hint={live?.powerW != null ? lampHint(live.powerLamps) : "tahmini tüketim"}
      />

      {/* LED'e giden güç (sürücü kayıpları hariç) — yalnızca ölçümle gelir. */}
      <Metric
        label="Yük Gücü"
        value={live?.loadPowerW != null ? formatPower(live.loadPowerW) : EMPTY}
        hint={live?.loadPowerW != null ? "LED'e giden güç" : EMPTY_HINT}
      />

      {/* Gerilim TOPLANMAZ: lamba başına ortalama gösterilir. */}
      <Metric
        label="LED Gerilimi"
        value={
          live?.ledVoltageV != null
            ? `${live.ledVoltageEstimated ? "≈" : ""}${tr1.format(live.ledVoltageV)} V`
            : EMPTY
        }
        hint={
          live?.ledVoltageV != null
            ? lampHint(
                live.ledVoltageLamps,
                live.ledVoltageEstimated ? "lamba ortalaması (tahmini)" : "lamba ortalaması",
              )
            : EMPTY_HINT
        }
      />

      {/* Gerçek arıza: açık arızası olan farklı lamba sayısı (fault_events). */}
      <Metric
        label="Arıza / Uyarı"
        value={formatInt(faults)}
        accent={faults > 0 ? "danger" : "muted"}
        hint={
          live
            ? faults > 0
              ? "lambada açık arıza"
              : "açık arıza yok"
            : faults > 0
              ? "ilgilenilmesi gereken bölge"
              : "her şey yolunda"
        }
      />
    </section>
  );
}
