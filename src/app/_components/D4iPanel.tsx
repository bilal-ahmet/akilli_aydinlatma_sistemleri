"use client";

import type { D4iSnapshot } from "@/app/_lib/types";
import { MAX_ARC_LEVEL, levelToPercent } from "@/types/lighting";

/**
 * Cihazın D4i periyodik raporundan gelen sürücü/LED telemetrisi. Veri
 * `GET /api/devices/:id/telemetry` ile kanal başına son satır olarak gelir;
 * arıza sayaçları gibi tüm ayrıntılar raporun ham `d4i` bloğunda (`raw`).
 */

const tr0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const tr3 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 });

function num(v: number | null | undefined, unit: string, fmt = tr1): string | null {
  return typeof v === "number" ? `${fmt.format(v)} ${unit}` : null;
}

/** Saniyeyi "12.480 sa" biçiminde çalışma süresine çevirir. */
function hours(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") return null;
  return `${tr0.format(Math.round(seconds / 3600))} sa`;
}

/** Sürücü ve LED bloklarındaki arıza bayrağı + sayaç çiftleri. */
const DRIVER_FAULTS: Array<[key: string, label: string]> = [
  ["general_failure", "Genel arıza"],
  ["undervoltage_failure", "Düşük gerilim"],
  ["overvoltage_failure", "Aşırı gerilim"],
  ["power_limitation", "Güç sınırlama"],
  ["thermal_derating", "Termal kısma"],
  ["thermal_shutdown", "Termal kapanma"],
];

const LED_FAULTS: Array<[key: string, label: string]> = [
  ["general_failure", "Genel arıza"],
  ["short_circuit", "Kısa devre"],
  ["open_circuit", "Açık devre"],
  ["thermal_derating", "Termal kısma"],
  ["thermal_shutdown", "Termal kapanma"],
];

function Row({ label, values }: { label: string; values: Array<string | null> }) {
  const shown = values.filter((v): v is string => v !== null);
  if (shown.length === 0) return null;
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <span className="font-mono text-text">{shown.join(" · ")}</span>
    </div>
  );
}

/** Arıza bayrağı aktifse kırmızı, değilse sayaç değeriyle sönük gösterilir. */
function Faults({
  block,
  pairs,
}: {
  block: Record<string, number | null> | undefined;
  pairs: Array<[string, string]>;
}) {
  if (!block) return null;
  const items = pairs
    .map(([key, label]) => {
      const active = block[key];
      const count = block[`${key}_count`];
      if (typeof active !== "number" && typeof count !== "number") return null;
      return { label, active: active === 1 || active === 255, count: count ?? null };
    })
    .filter((x): x is { label: string; active: boolean; count: number | null } => x !== null);

  if (items.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.label}
          className={`rounded-md px-1.5 py-0.5 text-[10px] ${
            it.active
              ? "bg-danger/15 font-semibold text-danger"
              : "bg-panel text-muted"
          }`}
          title={it.active ? `${it.label}: aktif` : `${it.label}: geçmiş sayaç`}
        >
          {it.label}
          {it.count !== null ? ` ${tr0.format(it.count)}` : ""}
        </span>
      ))}
    </div>
  );
}

export function D4iPanel({
  rows,
  loading,
  onRefresh,
}: {
  rows: D4iSnapshot[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">
          D4i telemetrisi{" "}
          <span className="text-xs font-normal text-muted">({rows.length} kanal)</span>
        </h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
        >
          {loading ? "Yükleniyor…" : "Yenile"}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          Bu cihazdan henüz D4i raporu gelmedi. Cihaz{" "}
          <code className="font-mono text-xs">d4i_periodic</code> yayınlamaya başlayınca
          sürücü ve LED verileri burada listelenir.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const drv = r.raw?.d4i?.driver;
            const led = r.raw?.d4i?.led;
            return (
              <div key={r.channel} className="rounded-xl border border-border bg-panel-2 p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-panel px-1.5 py-0.5 font-mono text-[11px] text-muted">
                    ch{r.channel}
                  </span>
                  {r.online === false ? (
                    <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                      çevrimdışı
                    </span>
                  ) : null}
                  {r.lampFailure ? (
                    <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                      lamba arızası
                    </span>
                  ) : null}
                  {!r.d4iSupported ? (
                    <span className="rounded-md bg-panel px-1.5 py-0.5 text-[10px] text-muted">
                      D4i desteklemiyor
                    </span>
                  ) : null}
                  {typeof r.actualLevel === "number" ? (
                    <span className="ml-auto font-mono text-[11px] text-accent">
                      seviye {r.actualLevel}/{MAX_ARC_LEVEL} · %
                      {levelToPercent(r.actualLevel)}
                    </span>
                  ) : null}
                </div>

                <div className="space-y-0.5">
                  <Row
                    label="Genel"
                    values={[num(r.powerW, "W"), num(r.energyWh, "Wh", tr1)]}
                  />
                  <Row
                    label="Sürücü"
                    values={[
                      num(r.driverTemperatureC, "°C", tr0),
                      num(r.driverVoltageV, "V", tr0),
                      num(drv?.mains_frequency_hz, "Hz", tr0),
                      typeof drv?.power_factor === "number"
                        ? `PF ${tr1.format(drv.power_factor)}`
                        : null,
                      num(drv?.output_current_percent, "% akım", tr0),
                      hours(r.driverOperatingTimeS),
                      typeof drv?.startup_count === "number"
                        ? `${tr0.format(drv.startup_count)} açılış`
                        : null,
                    ]}
                  />
                  <Faults block={drv} pairs={DRIVER_FAULTS} />
                  <Row
                    label="LED"
                    values={[
                      num(r.ledTemperatureC, "°C", tr0),
                      num(r.ledVoltageV, "V", tr1),
                      num(r.ledCurrentA, "A", tr3),
                      hours(led?.operating_time_s),
                      typeof led?.startup_count === "number"
                        ? `${tr0.format(led.startup_count)} açılış`
                        : null,
                    ]}
                  />
                  <Faults block={led} pairs={LED_FAULTS} />
                  <Row
                    label="Sınırlar"
                    values={[
                      typeof r.minLevel === "number" ? `min ${r.minLevel}` : null,
                      typeof r.maxLevel === "number" ? `max ${r.maxLevel}` : null,
                      typeof r.physicalMinLevel === "number"
                        ? `fiziksel min ${r.physicalMinLevel}`
                        : null,
                    ]}
                  />
                </div>

                {r.recordedAt ? (
                  <p className="mt-1.5 text-[10px] text-muted">
                    {new Date(r.recordedAt).toLocaleString("tr-TR", {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
