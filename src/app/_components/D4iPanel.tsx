"use client";

import type { D4iSnapshot } from "@/app/_lib/types";
import { MAX_ARC_LEVEL, levelToPercent } from "@/types/lighting";
import { DRIVER_FAULTS, LED_FAULTS, isFlagActive, type FaultKey } from "@/lib/faults";
import {
  pickBool,
  pickNumber,
  pickString,
  readCounter,
  readMeasurement,
  reasonLabel,
  type D4iBlock,
  type Reading,
} from "@/lib/d4i";

/**
 * Cihazın D4i periyodik raporundan gelen sürücü/LED telemetrisi. Veri
 * `GET /api/devices/:id/telemetry` ile kanal başına son satır olarak gelir.
 *
 * Ölçümler `raw` üzerinden okunur (`lib/d4i.ts`): sürücü doğrulayamadığı
 * değerleri `null`'a çektiği için `d4i_telemetry` sütunları boş kalabiliyor.
 * Doğrulanmış değer düz, tahmini `≈`, doğrulanmamış ham ölçüm `*` ile yazılır;
 * ham/teknik alanlar ana ızgarada değil "Teknik detay" bölümünde durur.
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

interface Metric {
  label: string;
  value: string | null;
  /** Etiketin yanındaki ⓘ açıklaması. */
  note?: string;
  /** Ölçümün güvenilirliği — `≈` / `*` işaretlerini belirler. */
  kind?: Reading["kind"];
}

/** Ölçümü birim ve güvenilirlik işaretiyle metne çevirir. */
function reading(r: Reading | null, unit: string, fmt = tr1): Metric["value"] {
  if (!r) return null;
  const prefix = r.kind === "estimated" ? "≈" : "";
  const suffix = r.kind === "unverified" ? " *" : "";
  return `${prefix}${fmt.format(r.value)} ${unit}${suffix}`;
}

/** Ölçümün ⓘ açıklaması: tahminin/şüphenin sebebi ve varsa ham değer. */
function readingNote(r: Reading | null, unit: string, fmt = tr1): string | undefined {
  if (!r || r.kind === "exact") return undefined;
  const parts: string[] = [
    r.kind === "estimated"
      ? "Sürücünün tahmini değeri — ölçüm doğrulanamadı."
      : "Ham ölçüm; sürücü doğrulayamadı.",
  ];
  if (typeof r.reported === "number") {
    parts.push(`Cihazın raporladığı ham değer: ${fmt.format(r.reported)} ${unit}`);
  }
  if (r.reason) parts.push(`Sebep: ${reasonLabel(r.reason)}`);
  return parts.join(" ");
}

/**
 * Etiket + değer ızgarası; değeri olmayan alanlar hiç basılmaz. Etiketler uzun
 * olabildiği için (örn. "Enerjilenme/başlatma sayısı") kırpılmaz, sarılır.
 */
function Metrics({ items }: { items: Metric[] }) {
  const shown = items.filter((m) => m.value !== null);
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {shown.map((m) => (
        <div key={m.label} className="min-w-0">
          <dt className="flex items-start text-xs leading-snug text-muted">
            <span>{m.label}</span>
            {m.note ? <InfoMark note={m.note} /> : null}
          </dt>
          <dd
            className={`font-mono text-sm ${
              m.kind === "estimated" || m.kind === "unverified" ? "text-accent" : "text-text"
            }`}
            title={m.note}
          >
            {m.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Sürücü / LED gibi bağımsız birimlerin kendi kutusu. Her biri kenarlıklı,
 * ikonlu başlıklı ayrı bir kart — böylece iki blok gözle net ayrılır, sayılar
 * tek bir yığın gibi görünmez.
 */
function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-panel/40 p-3">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
        {icon ? (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            {icon}
          </span>
        ) : null}
        {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Lambanın en önemli sayıları için büyük, okunur bir kutu. Cihaz kartının
 * tepesindeki özet şeridini oluşturur — göz önce buraya gider, ayrıntılar
 * (sürücü/LED) altta kalır.
 */
function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel/70 px-3 py-2">
      <p className="text-[11px] leading-tight text-muted">{label}</p>
      <p
        className={`mt-1 font-mono text-lg font-semibold leading-none ${
          accent ? "text-accent" : "text-text"
        }`}
      >
        {value}
      </p>
      {sub ? <p className="mt-1 text-[10px] leading-tight text-muted">{sub}</p> : null}
    </div>
  );
}

/** Cihaz kartının tepesindeki özet şeridi — dolu olan ölçümler kutu olur. */
function SummaryStats({ r }: { r: D4iSnapshot }) {
  const tiles: Array<{ label: string; value: string; sub?: string; accent?: boolean }> = [];

  if (typeof r.actualLevel === "number") {
    tiles.push({
      label: "Işık seviyesi",
      value: `%${levelToPercent(r.actualLevel)}`,
      sub: `${r.actualLevel}/${MAX_ARC_LEVEL} arc`,
      accent: true,
    });
  }
  const power = num(r.powerW, "W");
  if (power) tiles.push({ label: "Anlık güç", value: power, sub: "şebekeden çekilen" });
  const load = num(r.raw?.d4i?.load_power?.value, "W", tr0);
  if (load) tiles.push({ label: "Yük gücü", value: load, sub: "LED'e giden" });
  const energy = num(r.energyWh, "Wh", tr1);
  if (energy) tiles.push({ label: "Toplam enerji", value: energy });

  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((t) => (
        <StatTile key={t.label} {...t} />
      ))}
    </div>
  );
}

interface FaultItem {
  label: string;
  note?: string;
  active: boolean;
  count: number | null;
  /** Ekrana yazılan sayı — doymuş sayaçlarda "253+". */
  text: string | null;
  saturated: boolean;
}

function faultItems(block: D4iBlock | undefined, keys: FaultKey[]): FaultItem[] {
  if (!block) return [];
  return keys
    .map(({ key, label, note }): FaultItem | null => {
      const flag = pickNumber(block, key);
      const counter = readCounter(block, key);
      if (flag === null && counter === null) return null;
      return {
        label,
        note,
        active: isFlagActive(flag),
        count: counter?.count ?? null,
        text: counter?.text ?? null,
        saturated: counter?.saturated ?? false,
      };
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
function Faults({ block, keys }: { block: D4iBlock | undefined; keys: FaultKey[] }) {
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
              title={
                it.saturated
                  ? "Sayaç tavana ulaştı ve saymayı bıraktı; gerçek sayı daha yüksek."
                  : undefined
              }
            >
              {it.text ?? "—"}
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
        {items.some((i) => i.saturated)
          ? " “+” ile biten sayaçlar tavana ulaşmış, gerçek sayı daha yüksek."
          : ""}
      </p>
    </div>
  );
}

/** Teknik detaydaki tek satır — değeri olmayan alan hiç basılmaz. */
function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 py-1">
      <dt className="w-40 shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-xs text-text">{value}</dd>
    </div>
  );
}

/**
 * Ana ızgaraya ait olmayan alanlar: ham (doğrulanamamış) ölçümler, doğrulama
 * sebepleri, ölçek üsleri, bank sürümleri ve bank 206 ham verisi. Ham JSON
 * dökümü yerine etiketli liste — teknik ama okunur.
 *
 * `<details>` kullanılıyor: state yok, klavye/erişilebilirlik tarayıcıdan gelir.
 */
function TechnicalDetail({ snapshot }: { snapshot: D4iSnapshot }) {
  const d4i = snapshot.raw?.d4i;
  if (!d4i) return null;

  const drv = d4i.driver;
  const led = d4i.led;

  const status = pickString(led, "measurement_status");
  const rawVoltage = pickNumber(led, "voltage_reported_v");
  const rawCurrent = pickNumber(led, "current_reported_a");
  const rawTemp = pickNumber(led, "temperature_reported_c");
  const estimationReason = pickString(led, "temperature_estimation_reason");
  const coherent = pickBool(d4i as D4iBlock, "sample_coherent") ?? pickBool(led, "sample_coherent");
  const sampleState =
    pickString(d4i as D4iBlock, "sample_state") ?? pickString(led, "measurement_state");
  const bankHex = pickString(d4i as D4iBlock, "bank_206_raw_hex");
  const bankLen = pickNumber(d4i as D4iBlock, "bank_206_length");
  const bankVer = pickNumber(d4i as D4iBlock, "bank_206_version");
  const drvVer = pickNumber(drv, "bank_version");
  const ledVer = pickNumber(led, "bank_version");
  const energyScale = d4i.energy?.scale_exponent;
  const powerScale = d4i.power?.scale_exponent;

  /** "1,8 V (doğrulanamadı)" — ham değerin neden ana ekranda olmadığını söyler. */
  const rawWithReason = (
    v: number | null,
    unit: string,
    reasonKey: string,
    fmt = tr1,
  ): string | null => {
    if (v === null) return null;
    const reason = pickString(led, reasonKey);
    return `${fmt.format(v)} ${unit}${reason ? ` — ${reasonLabel(reason)}` : " — doğrulanamadı"}`;
  };

  const versions = [
    drvVer !== null ? `sürücü v${drvVer}` : null,
    ledVer !== null ? `LED v${ledVer}` : null,
    bankVer !== null
      ? `bank206 v${bankVer}${bankLen !== null ? ` (${bankLen} bayt)` : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const scales = [
    typeof energyScale === "number" ? `enerji ×10^${energyScale}` : null,
    typeof powerScale === "number" ? `güç ×10^${powerScale}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sample = [
    coherent !== null ? `örnek ${coherent ? "tutarlı" : "TUTARSIZ"}` : null,
    sampleState ? `durum: ${sampleState}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const rows: Array<[string, string | null]> = [
    ["Ölçüm durumu", status ? reasonLabel(status) : null],
    ["Ham LED gerilimi", rawWithReason(rawVoltage, "V", "voltage_implausibility_reason")],
    ["Ham LED akımı", rawWithReason(rawCurrent, "A", "current_implausibility_reason", tr3)],
    ["Ham LED sıcaklığı", rawWithReason(rawTemp, "°C", "temperature_implausibility_reason", tr0)],
    ["Tahmin sebebi", estimationReason ? reasonLabel(estimationReason) : null],
    ["Örnekleme", sample || null],
    ["Bank sürümleri", versions || null],
    ["Ölçek üsleri", scales || null],
    ["bank 206 (ham)", bankHex],
  ];

  if (rows.every(([, v]) => !v)) return null;

  return (
    <details className="mt-2.5 border-t border-border pt-2">
      <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-text">
        <span className="mr-1 inline-block transition-transform">▸</span>
        Teknik detay
      </summary>
      <dl className="mt-1.5 divide-y divide-border/60">
        {rows.map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
      </dl>
    </details>
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

            // LED ölçümleri sütunlardan değil ham bloktan okunur: sürücü
            // doğrulayamadığı değeri null'a çekiyor, sütunlar da boş kalıyor.
            // `readMeasurement` doğrulanmış → tahmini → ham sırasını uygular ve
            // eski (yalnız `voltage_v` gönderen) payload'larla uyumludur.
            const ledVoltage = readMeasurement(led, "voltage", "v");
            const ledCurrent = readMeasurement(led, "current", "a");
            const ledTemp = readMeasurement(led, "temperature", "c");
            return (
              <div
                key={r.channel}
                className={`rounded-xl border bg-panel-2 p-3.5 ${
                  isFaulty(r) ? "border-danger/50" : "border-border"
                }`}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
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
                    <span className="ml-auto rounded-md bg-panel px-2 py-0.5 text-xs text-muted">
                      D4i desteklemiyor
                    </span>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <SummaryStats r={r} />

                  <Section
                    title="Sürücü"
                    icon={
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="5" y="5" width="14" height="14" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
                      </svg>
                    }
                  >
                    <Metrics
                      items={[
                        { label: "Çalışma sıcaklığı", value: num(r.driverTemperatureC, "°C", tr0) },
                        { label: "Çalışma gerilimi", value: num(r.driverVoltageV, "V", tr0) },
                        {
                          label: "Şebeke frekansı",
                          value: num(pickNumber(drv, "mains_frequency_hz"), "Hz", tr0),
                        },
                        {
                          label: "Güç katsayısı",
                          value: num(pickNumber(drv, "power_factor"), "", tr1),
                        },
                        {
                          label: "Çıkış akımı seviyesi",
                          // Yüzde Türkçede önce yazılır (%85) — kartın üstündeki
                          // seviye göstergesiyle aynı biçim.
                          value: (() => {
                            const v = pickNumber(drv, "output_current_percent");
                            return v === null ? null : `%${tr0.format(v)}`;
                          })(),
                          note: "Sürücünün LED'e verdiği akımın, azami akıma oranı.",
                        },
                        { label: "Çalışma süresi", value: hours(r.driverOperatingTimeS) },
                        {
                          label: "Enerjilenme/başlatma sayısı",
                          value: num(pickNumber(drv, "startup_count"), "", tr0),
                          note: "Sürücüye enerji verilip başlatılma sayısı — lambanın aç/kapa sayısı değildir.",
                        },
                      ]}
                    />
                    <Faults block={drv} keys={DRIVER_FAULTS} />
                  </Section>

                  <Section
                    title="LED"
                    icon={
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
                      </svg>
                    }
                  >
                    <Metrics
                      items={[
                        {
                          label: "LED gerilimi",
                          value: reading(ledVoltage, "V", tr1),
                          note: readingNote(ledVoltage, "V", tr1),
                          kind: ledVoltage?.kind,
                        },
                        {
                          label: "LED akımı",
                          value: reading(ledCurrent, "A", tr3),
                          note: readingNote(ledCurrent, "A", tr3),
                          kind: ledCurrent?.kind,
                        },
                        {
                          label: "LED sıcaklığı",
                          value: reading(ledTemp, "°C", tr0),
                          note: readingNote(ledTemp, "°C", tr0),
                          kind: ledTemp?.kind,
                        },
                        { label: "Çalışma süresi", value: hours(pickNumber(led, "operating_time_s")) },
                        {
                          label: "Enerjilenme/başlatma sayısı",
                          value: num(pickNumber(led, "startup_count"), "", tr0),
                          note: "LED modülünün enerjilenme sayısı — lambanın aç/kapa sayısı değildir.",
                        },
                      ]}
                    />
                    {[ledVoltage, ledCurrent, ledTemp].some((m) => m?.kind === "unverified") ? (
                      <p className="mt-1.5 text-xs text-muted">
                        * Ham ölçüm; gerilim/güç kontrolüyle doğrulanamadı.
                      </p>
                    ) : null}
                    {[ledVoltage, ledCurrent, ledTemp].some((m) => m?.kind === "estimated") ? (
                      <p className="mt-1 text-xs text-muted">
                        ≈ ile yazılan değerler sürücünün tahminidir; ham ölçümler “Teknik
                        detay” bölümünde.
                      </p>
                    ) : null}
                    <Faults block={led} keys={LED_FAULTS} />
                  </Section>

                  {(() => {
                    // Seviye sınırları ikincil bilgi — ayrı bir bölüm yerine tek
                    // satır muted metin, kartın yükünü azaltır.
                    const limits = [
                      typeof r.minLevel === "number" ? `en düşük ${r.minLevel}` : null,
                      typeof r.maxLevel === "number" ? `en yüksek ${r.maxLevel}` : null,
                      typeof r.physicalMinLevel === "number"
                        ? `fiziksel min ${r.physicalMinLevel}`
                        : null,
                    ].filter(Boolean);
                    if (limits.length === 0) return null;
                    return (
                      <p className="border-t border-border pt-3 text-xs text-muted">
                        <span className="font-medium">Seviye sınırları (arc):</span>{" "}
                        <span className="font-mono text-text">{limits.join(" · ")}</span>
                      </p>
                    );
                  })()}
                </div>

                <TechnicalDetail snapshot={r} />

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
