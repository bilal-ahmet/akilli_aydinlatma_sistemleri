"use client";

import { useState } from "react";
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
  return typeof v === "number" ? `${fmt.format(v)}${unit ? ` ${unit}` : ""}` : null;
}

/** Saniyeyi "12.480 sa" biçiminde çalışma süresine çevirir. */
function hours(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number") return null;
  return `${tr0.format(Math.round(seconds / 3600))} sa`;
}

/**
 * Sürücü ve LED bloklarındaki arıza bayrağı + sayaç çiftleri. İlk sıradaki
 * `general_failure` özet olarak gösterilir, kalanı tıklanınca açılır.
 */
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

type Metric = [label: string, value: string | null];

/** Etiket + değer çiftleri; değeri olmayan alanlar hiç basılmaz. */
function Metrics({ items }: { items: Metric[] }) {
  const shown = items.filter((m): m is [string, string] => m[1] !== null);
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {shown.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="truncate text-xs text-muted">{label}</dt>
          <dd className="truncate font-mono text-sm text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-2.5">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      {children}
    </div>
  );
}

interface FaultItem {
  label: string;
  active: boolean;
  count: number | null;
}

function faultItems(
  block: Record<string, number | null> | undefined,
  pairs: Array<[string, string]>,
): FaultItem[] {
  if (!block) return [];
  return pairs
    .map(([key, label]) => {
      const active = block[key];
      const count = block[`${key}_count`];
      if (typeof active !== "number" && typeof count !== "number") return null;
      return { label, active: active === 1 || active === 255, count: count ?? null };
    })
    .filter((x): x is FaultItem => x !== null);
}

function Chip({ item }: { item: FaultItem }) {
  return (
    <span
      className={`rounded-md px-2 py-1 text-xs ${
        item.active ? "bg-danger/15 font-semibold text-danger" : "bg-panel text-muted"
      }`}
      title={item.active ? `${item.label}: aktif` : `${item.label}: geçmiş sayaç`}
    >
      {item.label}
      {item.count !== null ? ` · ${tr0.format(item.count)}` : ""}
    </span>
  );
}

/**
 * Arıza özeti: kapalıyken yalnızca genel arıza (ve varsa aktif arıza sayısı)
 * görünür; tıklanınca kalan arıza bayrakları/sayaçları açılır.
 */
function Faults({
  block,
  pairs,
}: {
  block: Record<string, number | null> | undefined;
  pairs: Array<[string, string]>;
}) {
  const [open, setOpen] = useState(false);
  const items = faultItems(block, pairs);
  if (items.length === 0) return null;

  const general = items[0];
  const rest = items.slice(1);
  const activeRest = rest.filter((i) => i.active).length;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={rest.length === 0}
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          general.active
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-border bg-panel text-muted hover:text-text"
        } disabled:cursor-default disabled:hover:text-muted`}
      >
        <span className={general.active ? "font-semibold" : ""}>{general.label}</span>
        <span className="font-mono text-text">
          {general.count !== null ? tr0.format(general.count) : general.active ? "aktif" : "—"}
        </span>
        {activeRest > 0 && !open ? (
          <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-xs font-semibold text-danger">
            {activeRest} aktif arıza
          </span>
        ) : null}
        {rest.length > 0 ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs">
            {open ? "gizle" : `+${rest.length} arıza`}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${open ? "rotate-180" : ""}`}
              aria-hidden
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        ) : null}
      </button>

      {open && rest.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {rest.map((it) => (
            <Chip key={it.label} item={it} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function D4iPanel({
  rows,
  names,
  loading,
  onRefresh,
}: {
  rows: D4iSnapshot[];
  /** Kanal → dashboard'da girilen lamba adı (yoksa "Lamba <ch>" kullanılır). */
  names: Map<number, string | null>;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-text">
          D4i telemetrisi{" "}
          <span className="text-sm font-normal text-muted">({rows.length} lamba)</span>
        </h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
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
        <div className="space-y-3">
          {rows.map((r) => {
            const drv = r.raw?.d4i?.driver;
            const led = r.raw?.d4i?.led;
            const name = names.get(r.channel) || `Lamba ${r.channel}`;
            return (
              <div key={r.channel} className="rounded-xl border border-border bg-panel-2 p-3.5">
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text">{name}</span>
                  <span className="font-mono text-xs text-muted">ch{r.channel}</span>
                  {r.online === false ? (
                    <span className="rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
                      çevrimdışı
                    </span>
                  ) : null}
                  {r.lampFailure ? (
                    <span className="rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
                      lamba arızası
                    </span>
                  ) : null}
                  {!r.d4iSupported ? (
                    <span className="rounded-md bg-panel px-2 py-0.5 text-xs text-muted">
                      D4i desteklemiyor
                    </span>
                  ) : null}
                  {typeof r.actualLevel === "number" ? (
                    <span className="ml-auto font-mono text-sm text-accent">
                      %{levelToPercent(r.actualLevel)}{" "}
                      <span className="text-xs text-muted">
                        ({r.actualLevel}/{MAX_ARC_LEVEL})
                      </span>
                    </span>
                  ) : null}
                </div>

                <div className="space-y-2.5">
                  <Metrics
                    items={[
                      ["Anlık güç", num(r.powerW, "W")],
                      ["Toplam enerji", num(r.energyWh, "Wh", tr1)],
                    ]}
                  />

                  <Section title="Sürücü">
                    <Metrics
                      items={[
                        ["Çalışma sıcaklığı", num(r.driverTemperatureC, "°C", tr0)],
                        ["Çalışma gerilimi", num(r.driverVoltageV, "V", tr0)],
                        ["Şebeke frekansı", num(drv?.mains_frequency_hz, "Hz", tr0)],
                        ["Güç katsayısı", num(drv?.power_factor, "", tr1)],
                        ["Çalışma akımı", num(drv?.output_current_percent, "%", tr0)],
                        ["Çalışma süresi", hours(r.driverOperatingTimeS)],
                        [
                          "Açma/kapama sayısı",
                          typeof drv?.startup_count === "number"
                            ? tr0.format(drv.startup_count)
                            : null,
                        ],
                      ]}
                    />
                    <Faults block={drv} pairs={DRIVER_FAULTS} />
                  </Section>

                  <Section title="LED">
                    <Metrics
                      items={[
                        ["Çalışma sıcaklığı", num(r.ledTemperatureC, "°C", tr0)],
                        ["Çalışma gerilimi", num(r.ledVoltageV, "V", tr1)],
                        ["Çalışma akımı", num(r.ledCurrentA, "A", tr3)],
                        ["Çalışma süresi", hours(led?.operating_time_s)],
                        [
                          "Açma/kapama sayısı",
                          typeof led?.startup_count === "number"
                            ? tr0.format(led.startup_count)
                            : null,
                        ],
                      ]}
                    />
                    <Faults block={led} pairs={LED_FAULTS} />
                  </Section>

                  <Section title="Seviye sınırları">
                    <Metrics
                      items={[
                        ["En düşük", typeof r.minLevel === "number" ? `${r.minLevel}` : null],
                        ["En yüksek", typeof r.maxLevel === "number" ? `${r.maxLevel}` : null],
                        [
                          "Fiziksel min",
                          typeof r.physicalMinLevel === "number"
                            ? `${r.physicalMinLevel}`
                            : null,
                        ],
                      ]}
                    />
                  </Section>
                </div>

                {r.recordedAt ? (
                  <p className="mt-2.5 text-xs text-muted">
                    Son rapor:{" "}
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
