"use client";

import { useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import {
  countSelection,
  isEmptyPlan,
  planStop,
  planTargets,
  pruneSelection,
  selectionText,
  type Selection,
} from "@/app/_lib/selection";
import { EFFECTS, MORSE_TEXT_MAX, normalizeMorseText, type Effect } from "@/lib/effects";
import { useDialogs } from "../PanelDialogs";
import { EmptyBox, PageHeader } from "../PanelUi";
import { ClockIcon } from "../ScheduleForm";
import { formatRunAt } from "@/lib/scheduleTime";
import { TargetChips, listState, planText, useZonedDevices } from "../TargetSelect";

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
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const { openSchedule } = useDialogs();

  const { zoned, devicesOf } = useZonedDevices(devices);

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

  const targetText = () => planText(plan, zones, allChosen);

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

  // Aynı efekti ve hedefi ileri bir saate zamanla.
  function schedule() {
    openSchedule({
      prefill: {
        action: "efekt",
        effectNumber: selected.number,
        effectText: selected.needsText ? text || null : null,
        selection: allChosen ? "all" : selection,
      },
      onSaved: (s) =>
        setSent(s.nextRunAt ? `Zamanlandı · ilk çalışma ${formatRunAt(new Date(s.nextRunAt))}.` : "Zamanlandı."),
    });
  }

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
            <TargetChips
              zones={zones}
              zoned={zoned}
              devicesOf={devicesOf}
              selection={selection}
              onChange={change}
              showFx
              className="-mx-5 overflow-x-auto px-5 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0"
            />
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
                <button
                  type="button"
                  onClick={schedule}
                  disabled={nothing}
                  title="Bu efekti ileri bir saatte çalıştır"
                  className="btn-line h-10 gap-1.5 px-3.5 text-sm"
                >
                  <ClockIcon />
                  Zamanla
                </button>
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

    </div>
  );
}
