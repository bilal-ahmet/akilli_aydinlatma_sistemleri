"use client";

import type { D4iSnapshot } from "@/app/_lib/types";
import { MAX_ARC_LEVEL, levelToPercent } from "@/types/lighting";
import { DRIVER_FAULTS, LED_FAULTS, isFlagActive, type FaultKey } from "@/lib/faults";

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

// Arıza bayrağı/etiket kataloğu lib/faults.ts'te — arıza geçmişi de aynı
// listeden okur. Buradaki ilk sıra (`general_failure`) özet olarak gösterilir,
// kalanı tıklanınca açılır.

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
  note?: string;
  active: boolean;
  count: number | null;
}

function faultItems(
  block: Record<string, number | null> | undefined,
  keys: FaultKey[],
): FaultItem[] {
  if (!block) return [];
  return keys
    .map(({ key, label, note }): FaultItem | null => {
      const active = block[key];
      const count = block[`${key}_count`];
      if (typeof active !== "number" && typeof count !== "number") return null;
      return { label, note, active: isFlagActive(active), count: count ?? null };
    })
    .filter((x): x is FaultItem => x !== null);
}

/** Satırda gösterilecek bir arıza var mı — panel başlığındaki özet için. */
function isFaulty(r: D4iSnapshot): boolean {
  if (r.lampFailure || r.online === false) return true;
  const drv = r.raw?.d4i?.driver;
  const led = r.raw?.d4i?.led;
  return (
    faultItems(drv, DRIVER_FAULTS).some((i) => i.active) ||
    faultItems(led, LED_FAULTS).some((i) => i.active)
  );
}

/** Etiketin yanındaki açıklama işareti — üstüne gelince `note` görünür. */
function InfoMark({ note }: { note: string }) {
  return (
    <span
      title={note}
      aria-label={note}
      className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-border text-[9px] font-bold leading-none text-muted align-text-top"
    >
      i
    </span>
  );
}

/**
 * Arıza sayaçları — hepsi tek ızgarada, katlama yok. Sayaçlar birbirinden
 * BAĞIMSIZDIR: `general_failure` sürücünün ayrı tuttuğu bir sayaçtır, yanındaki
 * özel arızaların toplamı değildir (bkz. lib/faults.ts GENERAL_NOTE), bu yüzden
 * biri diğerlerinin "özeti" gibi sunulmaz.
 *
 * Karmaşayı katlayarak değil, ağırlıkla çözüyoruz: aktif arıza kırmızı, sıfır
 * sayaç sönük, dolu sayaç normal — göz doğrudan anlamlı olana gidiyor.
 */
function Faults({
  block,
  keys,
}: {
  block: Record<string, number | null> | undefined;
  keys: FaultKey[];
}) {
  const items = faultItems(block, keys);
  if (items.length === 0) return null;

  const activeCount = items.filter((i) => i.active).length;

  return (
    <div className="mt-3 rounded-lg border border-border bg-panel/60 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Arıza sayaçları
        </p>
        {activeCount > 0 ? (
          <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-xs font-semibold text-danger">
            {activeCount} aktif
          </span>
        ) : (
          <span className="text-xs text-muted">· şu an aktif arıza yok</span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="min-w-0">
            <dt
              className={`flex items-center text-xs ${it.active ? "text-danger" : "text-muted"}`}
            >
              <span className="truncate">{it.label}</span>
              {it.note ? <InfoMark note={it.note} /> : null}
            </dt>
            <dd
              className={`font-mono text-sm ${
                it.active
                  ? "font-semibold text-danger"
                  : it.count
                    ? "text-text"
                    : "text-muted/60"
              }`}
            >
              {it.count !== null ? tr0.format(it.count) : "—"}
              {it.active ? (
                <span className="ml-1.5 rounded bg-danger/15 px-1 py-0.5 text-[10px] font-semibold uppercase">
                  aktif
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-2 text-xs text-muted">
        Sayaçlar sürücünün ömrü boyunca birikir ve birbirinden bağımsızdır; sıfır
        olmayan bir sayaç geçmişte yaşanmış arızayı gösterir, aktif arızayı değil.
      </p>
    </div>
  );
}

export function D4iPanel({
  rows,
  names,
  loading,
  updatedAt,
  onRefresh,
}: {
  rows: D4iSnapshot[];
  /** Kanal → dashboard'da girilen lamba adı (yoksa "Lamba <ch>" kullanılır). */
  names: Map<number, string | null>;
  loading: boolean;
  /** Verinin en son çekildiği an (ms) — canlı tazelemenin çalıştığını gösterir. */
  updatedAt: number | null;
  onRefresh: () => void;
}) {
  const faulty = rows.filter(isFaulty).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
          D4i telemetrisi{" "}
          <span className="text-sm font-normal text-muted">({rows.length} lamba)</span>
          {faulty > 0 ? (
            <span className="rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
              {faulty} lambada arıza
            </span>
          ) : null}
        </h3>
        <div className="flex items-center gap-2">
          {/* Cihazdan her yeni rapor geldiğinde panel kendiliğinden tazelenir. */}
          <span
            className="flex items-center gap-1.5 text-xs text-muted"
            title={
              updatedAt
                ? `Son güncelleme: ${new Date(updatedAt).toLocaleTimeString("tr-TR")} — cihazdan yeni rapor geldikçe otomatik yenilenir`
                : "Cihazdan yeni rapor geldikçe otomatik yenilenir"
            }
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            canlı
            {updatedAt ? (
              <span className="hidden font-mono sm:inline">
                {new Date(updatedAt).toLocaleTimeString("tr-TR")}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-text disabled:opacity-50"
          >
            {loading ? "Yükleniyor…" : "Yenile"}
          </button>
        </div>
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
              <div
                key={r.channel}
                className={`rounded-xl border bg-panel-2 p-3.5 ${
                  isFaulty(r) ? "border-danger/50" : "border-border"
                }`}
              >
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
                    <Faults block={drv} keys={DRIVER_FAULTS} />
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
                    <Faults block={led} keys={LED_FAULTS} />
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
