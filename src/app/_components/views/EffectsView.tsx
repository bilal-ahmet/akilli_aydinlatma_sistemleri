"use client";

import { useMemo, useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import type { DeviceView, Zone } from "@/app/_lib/types";
import {
  countSelection,
  deviceSelState,
  isEmptyPlan,
  planStop,
  planTargets,
  pruneSelection,
  replaceWithin,
  selectionText,
  type Selection,
  type SelState,
} from "@/app/_lib/selection";
import { EFFECTS, MORSE_TEXT_MAX, effectByNumber, normalizeMorseText, type Effect } from "@/lib/effects";
import { Modal } from "../Modal";
import { SelectionQuickBar } from "../SelectionQuickBar";
import { EmptyBox, PageHeader } from "../PanelUi";
import { DeviceTable } from "./DeviceTable";

/**
 * Kart önizlemesi: 8 noktanın parlaklığı — efektin zaman içindeki (tek lamba)
 * ya da hat boyunca (çok lambalı) karakterini kabaca anlatır. Yalnızca görsel;
 * firmware davranışının kaynağı `lib/effects.ts`.
 */
const PREVIEW: Record<number, number[]> = {
  1: [0.1, 0.3, 0.5, 0.7, 0.9, 0.7, 0.5, 0.3],
  2: [1, 1, 0.1, 0.1, 1, 1, 0.1, 0.1],
  3: [1, 0.1, 0.1, 0.1, 1, 0.1, 0.1, 0.1],
  4: [0.6, 0.2, 0.9, 0.4, 0.7, 0.15, 1, 0.35],
  5: [0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1],
  6: [0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3, 0.2],
  7: [1, 0.2, 1, 0.1, 0.1, 0.1, 0.1, 0.1],
  8: [0.7, 0.8, 0.6, 0.85, 0.65, 0.75, 0.9, 0.7],
  9: [1, 1, 1, 0.1, 0.5, 0.5, 0.5, 0.1],
  10: [1, 0.1, 1, 0.1, 1, 0.1, 0.1, 0.1],
  11: [0.2, 0.2, 1, 0.2, 0.2, 0.2, 0.9, 0.2],
  12: [0.05, 0.05, 1, 0.3, 0.05, 0.05, 0.05, 0.8],
  13: [1, 0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.8],
  14: [0.1, 0.1, 1, 0.1, 0.1, 0.1, 1, 0.1],
  15: [0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55],
  16: [0.1, 0.2, 0.5, 1, 0.5, 0.2, 0.1, 0.1],
  17: [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.85, 1],
  18: [1, 0.1, 0.1, 1, 0.1, 0.1, 1, 0.1],
  19: [0.2, 0.6, 1, 0.6, 0.2, 0.6, 1, 0.6],
  20: [0.4, 0.5, 0.35, 0.6, 0.7, 0.55, 0.65, 0.8],
  21: [1, 0.1, 0.1, 0.1, 1, 0.1, 1, 1],
  22: [1, 0.1, 1, 1, 1, 0.1, 1, 0.1],
  23: [1, 0.15, 1, 0.15, 1, 0.15, 1, 0.15],
  24: [0.2, 0.45, 0.8, 1, 0.8, 0.45, 0.2, 0.1],
  25: [0.1, 0.1, 0.15, 0.3, 0.55, 1, 0.1, 0.1],
  26: [0.1, 0.1, 0.1, 1, 0.1, 0.1, 0.1, 0.1],
  27: [1, 1, 1, 1, 1, 0.1, 0.1, 0.1],
  28: [0.1, 1, 0.1, 0.1, 0.1, 0.1, 1, 0.1],
};
const FLAT = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8];

const SINGLE_LAMP_FX = EFFECTS.filter((fx) => !fx.allLamps);
const ALL_LAMP_FX = EFFECTS.filter((fx) => fx.allLamps);

function Preview({ number }: { number: number }) {
  return (
    <div aria-hidden className="flex h-16 items-center justify-around rounded-[10px] bg-[#1a1916] px-3">
      {(PREVIEW[number] ?? FLAT).map((o, i) => (
        <span
          key={i}
          className="h-3 w-3 rounded-full bg-[oklch(0.82_0.15_75)] shadow-[0_0_12px_oklch(0.8_0.16_72)]"
          style={{ opacity: o }}
        />
      ))}
    </div>
  );
}

function EffectCard({
  fx,
  selected,
  runningIn,
  onSelect,
}: {
  fx: Effect;
  selected: boolean;
  runningIn: number;
  onSelect: () => void;
}) {
  // Efektin sıra numarası firmware kontratıdır; müşteriye bir şey anlatmaz.
  const technical = useTechnical();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col gap-4 rounded-2xl bg-panel p-5 text-left transition-[border-color,box-shadow] ${
        selected
          ? "border-2 border-glow p-[19px] shadow-[0_8px_24px_oklch(0.77_0.16_68/.18)]"
          : "border border-border hover:border-border-strong"
      }`}
    >
      <Preview number={fx.number} />
      <span className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-text">
            {technical ? (
              <span className="mr-1.5 font-mono text-[11px] font-normal text-muted">{fx.number}</span>
            ) : null}
            {fx.label}
          </span>
          {runningIn > 0 ? (
            <span className="shrink-0 text-xs font-semibold text-accent">Çalışıyor</span>
          ) : null}
        </span>
        <span className="text-[13px] leading-[1.45] text-muted">{fx.desc}</span>
        {fx.minLamps != null || fx.needsText ? (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {fx.minLamps != null ? (
              <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                en az {fx.minLamps} lamba
              </span>
            ) : null}
            {fx.needsText ? (
              <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">yazı girilir</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const fxLabel = (n: number) => effectByNumber(n)?.label ?? `#${n}`;

const checkbox =
  "h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--acc)] disabled:cursor-not-allowed disabled:opacity-40";

/** Bir cihaz listesinin seçim durumu: hiçbiri / bir kısmı / tamamı (cihazın tamamı). */
function listState(sel: Selection, list: DeviceView[]): SelState {
  if (list.length === 0) return "none";
  const states = list.map((d) => deviceSelState(sel, d));
  if (states.every((s) => s === "all")) return "all";
  return states.some((s) => s !== "none") ? "some" : "none";
}

/** Bölgedeki seçili cihaz sayısı (kısmen seçili cihaz da sayılır). */
const pickedIn = (sel: Selection, list: DeviceView[]) =>
  list.filter((d) => deviceSelState(sel, d) !== "none").length;

/**
 * Hedef seçici penceresi: solda bölgeler, sağda seçili bölgenin cihazları
 * (bölge detayındaki tabloyla aynı; lambalar da seçilebilir).
 */
function TargetPicker({
  zones,
  devicesByZone,
  selection,
  onChange,
  onClose,
}: {
  zones: Zone[];
  devicesByZone: (zoneId: string) => DeviceView[];
  selection: Selection;
  onChange: (next: Selection) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => zones.find((z) => devicesByZone(z.id).length > 0)?.id ?? zones[0]?.id);
  const zone = zones.find((z) => z.id === active);
  const list = zone ? devicesByZone(zone.id) : [];
  const total = countSelection(selection);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Nerede çalışsın?"
      subtitle="Bölgenin tamamını ya da tek tek cihaz ve lambaları seçin."
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-muted">
            {total.devices + total.lamps > 0 ? `${selectionText(total)} seçili` : "Seçim yok"}
          </span>
          <button type="button" onClick={onClose} className="btn-glow h-10 px-5 text-sm">
            Tamam
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Bölgeler" className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
          {zones.map((z) => {
            const zl = devicesByZone(z.id);
            const st = listState(selection, zl);
            const on = z.id === active;
            return (
              <div
                key={z.id}
                className={`flex shrink-0 items-center gap-2 rounded-[10px] px-2.5 py-2 text-sm transition-colors ${
                  on ? "bg-panel-2 font-semibold text-text" : "text-ink-2 hover:bg-panel-2/60"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={zl.length === 0}
                  aria-label={`${z.name} bölgesinin tamamı`}
                  checked={st === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = st === "some";
                  }}
                  onChange={() => onChange(replaceWithin(selection, zl, () => st !== "all"))}
                  className={checkbox}
                />
                <button
                  type="button"
                  onClick={() => setActive(z.id)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                >
                  <span className="truncate">{z.name}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-muted">
                    {zl.length === 0 ? "—" : `${pickedIn(selection, zl)}/${zl.length}`}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-3">
          {zone && list.length > 0 ? (
            <>
              <SelectionQuickBar devices={list} selection={selection} onChange={onChange} />
              <div className="overflow-hidden rounded-xl border border-border">
                <DeviceTable devices={list} selection={selection} onSelectionChange={onChange} compact />
              </div>
            </>
          ) : (
            <EmptyBox>Bu bölgede tanımlı cihaz yok.</EmptyBox>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Efektler: üstte "Nerede çalışsın?" (bölge çipleri + ayrıntılı seçim
 * penceresi), ortada efekt kataloğu, altta sabit başlat/durdur çubuğu.
 *
 * Komut planı `planTargets`: bütün cihazlar tamamen seçiliyse tek "Tüm Sistem"
 * isteği (sunucu bölge topic'lerine fanout eder), tamamen seçili bölgeye bölge
 * komutu, kısmi seçimde cihaz/lamba komutları. Çok lambalı efektte lamba
 * seçimi cihazın tamamına yükselir; lambası yetmeyen cihaz atlanır.
 */
export function EffectsView() {
  const { zones, devices, applyEffect, stopEffect } = useLighting();
  const { canWrite } = usePanel();
  const [selected, setSelected] = useState<Effect>(EFFECTS[0]);
  // "all": varsayılan, tüm cihazlar (yeni yüklenen/eklenen cihaz da dahil).
  const [picked, setPicked] = useState<Selection | "all">("all");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const zoned = useMemo(() => devices.filter((d) => d.zoneSlug !== null), [devices]);
  const devicesByZone = useMemo(() => {
    const m = new Map<string, DeviceView[]>();
    for (const d of zoned) {
      const list = m.get(d.zoneSlug!);
      if (list) list.push(d);
      else m.set(d.zoneSlug!, [d]);
    }
    return m;
  }, [zoned]);
  const zoneDevices = (zoneId: string) => devicesByZone.get(zoneId) ?? [];

  const selection: Selection =
    picked === "all" ? new Map(zoned.map((d) => [d.deviceId, null])) : pruneSelection(picked, zoned);
  const change = (next: Selection) => {
    setPicked(next);
    setSent(null);
  };

  const plan = planTargets(selection, zoned, zones, selected);
  const stopPlan = planStop(selection, zoned, zones);
  const allChosen = zoned.length > 0 && listState(selection, zoned) === "all" && plan.skipped.length === 0;
  const nothing = isEmptyPlan(plan);
  const count = countSelection(selection);

  /** Efektin çalıştığı yer sayısı: bölge + (efektte olmayan bölgedeki) cihaz. */
  const runningCount = (n: number) => {
    const zonesOn = zones.filter((z) => z.isOn && z.activeFx === n);
    const inZone = new Set(zonesOn.map((z) => z.id));
    return (
      zonesOn.length +
      devices.filter((d) => d.activeFx === n && !(d.zoneSlug && inZone.has(d.zoneSlug))).length
    );
  };

  /** Hedef özeti: "Tüm bölgeler", "Park Yolu", "2 bölge ve 3 cihaz", "1 lamba". */
  function targetText(): string {
    if (allChosen) return "tüm bölgeler";
    const parts: string[] = [];
    if (plan.zones.length === 1) parts.push(zones.find((z) => z.id === plan.zones[0])?.name ?? "1 bölge");
    else if (plan.zones.length > 1) parts.push(`${plan.zones.length} bölge`);
    if (plan.devices.length) parts.push(`${plan.devices.length} cihaz`);
    if (plan.lamps.length) parts.push(`${plan.lamps.length} lamba`);
    return parts.join(", ");
  }

  function start() {
    if (nothing) return;
    // Boş metin gönderilmez → cihaz son ayarlanan metni tekrar çalar.
    const t = selected.needsText ? text || undefined : undefined;
    applyEffect(allChosen ? "all" : plan, selected.number, t);
    const skipped = plan.skipped.length ? ` ${plan.skipped.length} cihaz atlandı (lamba sayısı yetmiyor).` : "";
    setSent(`${selected.label} ${targetText()} için başlatıldı.${skipped}`);
  }

  // Yalnızca efekt çalışan hedeflere, her biri kendi son şiddetine döner
  // ("Tüm Sistem" durdurması hepsini genel şiddete çekerdi).
  function stop() {
    stopEffect(stopPlan);
    setSent("Efekt durduruldu; lambalar son şiddetine döndü.");
  }

  // Seçilebilir alan olduğu anlaşılsın: el imleci + üzerine gelince hafif ton.
  const chip = (state: SelState) =>
    `inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${
      state === "all"
        ? "border border-text bg-text font-medium text-bg enabled:hover:bg-text/85"
        : state === "some"
          ? "border border-glow/60 bg-glow/15 font-medium text-text enabled:hover:bg-glow/25"
          : "border border-border bg-panel text-ink-2 enabled:hover:border-glow/50 enabled:hover:bg-glow/10 enabled:hover:text-text"
    }`;

  const section = (heading: string, note: string, list: readonly Effect[]) => (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow">
        {heading} <span className="font-normal normal-case tracking-normal">· {note}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {list.map((fx) => (
          <EffectCard
            key={fx.number}
            fx={fx}
            selected={fx.number === selected.number}
            runningIn={runningCount(fx.number)}
            onSelect={() => {
              setSelected(fx);
              setSent(null);
            }}
          />
        ))}
      </div>
    </section>
  );

  const allState = listState(selection, zoned);
  const stopCount = stopPlan.zones.length + stopPlan.devices.length + stopPlan.lamps.length;

  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        title="Efektler"
        subtitle="Nerede çalışacağını seçin, bir efekt seçin ve başlatın."
      />

      {zones.length === 0 ? (
        <EmptyBox>Efekt çalıştırmak için önce bir bölge oluşturun.</EmptyBox>
      ) : (
        <fieldset disabled={!canWrite} className="m-0 flex min-w-0 flex-col gap-[22px] border-0 p-0">
          <section
            aria-label="Nerede çalışsın?"
            className="flex flex-col gap-3 rounded-2xl border border-border bg-panel px-5 py-[18px]"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-text">Nerede çalışsın?</h2>
              <span className="text-[13px] text-muted">
                {count.devices + count.lamps === 0 ? "Seçim yok" : `${selectionText(count)} seçili`}
              </span>
            </div>
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0">
              <button
                type="button"
                className={chip(allState)}
                disabled={zoned.length === 0}
                aria-pressed={allState === "all"}
                onClick={() => change(allState === "all" ? new Map() : new Map(zoned.map((d) => [d.deviceId, null])))}
              >
                Tüm bölgeler
              </button>
              {zones.map((z) => {
                const zl = zoneDevices(z.id);
                const st = listState(selection, zl);
                return (
                  <button
                    key={z.id}
                    type="button"
                    className={chip(st)}
                    disabled={zl.length === 0}
                    aria-pressed={st === "all" ? true : st === "some" ? "mixed" : false}
                    title={zl.length === 0 ? "Bu bölgede tanımlı cihaz yok" : undefined}
                    onClick={() => change(replaceWithin(selection, zl, () => st !== "all"))}
                  >
                    {z.name}
                    <span className={`font-mono text-[11.5px] ${st === "all" ? "opacity-70" : "text-muted"}`}>
                      {zl.length === 0 ? "—" : `${pickedIn(selection, zl)}/${zl.length}`}
                    </span>
                    {z.isOn && z.activeFx != null ? (
                      <span className="text-[11.5px] text-accent">✦ {fxLabel(z.activeFx)}</span>
                    ) : null}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                disabled={zoned.length === 0}
                className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-glow/50 bg-glow/[.06] px-3.5 text-[13px] font-semibold text-accent transition-colors duration-150 enabled:hover:border-glow enabled:hover:bg-glow/15 disabled:cursor-not-allowed disabled:opacity-45 sm:ml-auto"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
                  <circle cx="16" cy="6" r="2" />
                  <circle cx="10" cy="12" r="2" />
                  <circle cx="18" cy="18" r="2" />
                </svg>
                Cihazları tek tek seç
              </button>
            </div>
            <p className="text-[12.5px] leading-snug text-muted">
              Bir bölgeye tıklayarak bölgenin tamamını seçin. Efekti bölgedeki yalnızca bazı cihaz ya
              da lambalarda çalıştırmak için <span className="font-medium text-ink-2">Cihazları tek tek seç</span>{" "}
              düğmesini kullanın.
            </p>
          </section>

          <div className="flex flex-col gap-6">
            {section("Tek lamba", "her lamba kendi başına çalar", SINGLE_LAMP_FX)}
            {section("Tüm lambalar", "cihazdaki lambalar birlikte çalar", ALL_LAMP_FX)}
          </div>

          <div
            role="region"
            aria-label="Efekti başlat"
            className="sticky bottom-4 z-30 flex flex-col gap-2 rounded-2xl border border-border-strong bg-panel/95 px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,.18)] backdrop-blur sm:px-5"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold text-text">{selected.label}</span>
                <span className="truncate text-[12.5px] text-muted">
                  {nothing
                    ? plan.skipped.length
                      ? `Seçili cihazların lambası bu efekt için yetmiyor (en az ${selected.minLamps}).`
                      : "Nerede çalışacağını seçin."
                    : `${targetText()}${plan.skipped.length ? ` · ${plan.skipped.length} cihaz atlanacak` : ""}${
                        selected.allLamps && count.lamps > 0 ? " · cihazın tüm lambalarında çalışır" : ""
                      }`}
                </span>
              </div>
              {selected.needsText ? (
                <label className="flex items-center gap-2">
                  <span className="text-[13px] text-ink-2">Metin</span>
                  <input
                    value={text}
                    maxLength={MORSE_TEXT_MAX}
                    onChange={(e) => setText(normalizeMorseText(e.target.value))}
                    placeholder="MERHABA"
                    title="Boş bırakırsanız cihaz son metni tekrar çalar."
                    className="field !h-9 !w-40 font-mono tracking-wider"
                  />
                  <span className="font-mono text-[11.5px] text-muted">
                    {text.length}/{MORSE_TEXT_MAX}
                  </span>
                </label>
              ) : null}
              <div className="flex gap-2">
                {stopCount > 0 ? (
                  <button type="button" onClick={stop} className="btn-line h-10 px-4 text-sm">
                    Durdur
                  </button>
                ) : null}
                <button type="button" onClick={start} disabled={nothing} className="btn-glow h-10 px-5 text-[14px]">
                  Başlat
                </button>
              </div>
            </div>
            {sent ? (
              <p aria-live="polite" className="text-[12.5px] text-ok">
                {sent}
              </p>
            ) : null}
          </div>
        </fieldset>
      )}

      {pickerOpen ? (
        <TargetPicker
          zones={zones}
          devicesByZone={zoneDevices}
          selection={selection}
          onChange={change}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
