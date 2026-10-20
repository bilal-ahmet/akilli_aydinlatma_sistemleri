"use client";

import { useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { effectByNumber } from "@/lib/effects";
import { formatRunAt } from "@/lib/scheduleTime";
import {
  countSelection,
  deviceState,
  isEmptyPlan,
  lampOn,
  planStop,
  planTargets,
  selectionText,
  type Selection,
} from "@/app/_lib/selection";
import { BrightnessSlider } from "./BrightnessSlider";
import { EffectPicker } from "./EffectPicker";
import { useDialogs } from "./PanelDialogs";
import { ClockIcon } from "./ScheduleForm";

/** Seçimin kararlı imzası — geri bildirim ve kaydırıcı değeri seçime bağlı tutulur. */
function signature(sel: Selection): string {
  return [...sel]
    .map(([mac, s]) => `${mac}:${s === null ? "*" : [...s].sort((a, b) => a - b).join(".")}`)
    .sort()
    .join("|");
}

/** Seçimin ortalama şiddeti (açık olanlar); hiçbiri açık değilse 100. */
function selectedBrightness(sel: Selection, devices: DeviceView[]): number {
  const values: number[] = [];
  for (const d of devices) {
    const s = sel.get(d.deviceId);
    if (s === undefined) continue;
    if (s === null) {
      const st = deviceState(d);
      if (st.isOn) values.push(st.brightness);
    } else {
      for (const l of d.lamps) if (s.has(l.channel) && lampOn(l)) values.push(l.brightness);
    }
  }
  return values.length ? Math.round(values.reduce((a, v) => a + v, 0) / values.length) : 100;
}

/**
 * Seçim varken altta sabit duran eylem çubuğu: Aç · Kapat · Şiddet · Efekt
 * (+ çalışan efekt varsa Durdur). Komut planı `planTargets`: bölgenin tamamı
 * seçiliyse tek bölge komutu, cihazın tamamı seçiliyse kanalsız, yalnızca bazı
 * lambaları seçiliyse kanallı komutlar. Seçim işlemden sonra korunur.
 */
export function SelectionActionBar({
  devices,
  selection,
  onClear,
}: {
  /** Seçimin geçerli olduğu liste (bölge detayında o bölgenin cihazları). */
  devices: DeviceView[];
  selection: Selection;
  onClear: () => void;
}) {
  const { zones, setTargetsPower, setTargetsBrightness, applyEffect, stopEffect } = useLighting();
  const { canWrite } = usePanel();
  const { openSchedule } = useDialogs();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [level, setLevel] = useState<{ sig: string; value: number } | null>(null);
  const [notice, setNotice] = useState<{ sig: string; text: string } | null>(null);

  const sig = signature(selection);
  const count = countSelection(selection);
  if (!canWrite || selection.size === 0) return null;

  const plan = planTargets(selection, devices, zones);
  const stopPlan = planStop(selection, devices, zones);
  const what = selectionText(count);
  const value = level?.sig === sig ? level.value : selectedBrightness(selection, devices);

  // Tek cihaz seçiliyse lamba sayısı bilinir → yetmeyen efektler baştan pasif.
  const single = selection.size === 1 ? devices.find((d) => selection.has(d.deviceId)) : undefined;
  const activeFx = single ? deviceState(single).activeFx : null;

  const say = (text: string) => setNotice({ sig, text });

  function power(on: boolean) {
    setTargetsPower(plan, on);
    say(`${what} ${on ? "açıldı" : "kapatıldı"}.`);
  }

  function dim(v: number) {
    setLevel({ sig, value: v });
    setTargetsBrightness(plan, v);
    setNotice(null);
  }

  function pickEffect(number: number, text?: string) {
    const fx = effectByNumber(number);
    const p = planTargets(selection, devices, zones, fx);
    setPickerOpen(false);
    if (isEmptyPlan(p)) {
      say(`Seçili cihazların hiçbirinde ${fx?.label ?? "bu efekt"} için yeterli lamba yok.`);
      return;
    }
    applyEffect(p, number, text);
    const skipped = p.skipped.length
      ? ` ${p.skipped.length} cihaz atlandı (en az ${fx?.minLamps} lamba gerekir).`
      : "";
    const upgraded = fx?.allLamps && count.lamps > 0 ? " Bu efekt cihazın tüm lambalarında çalışır." : "";
    say(`${fx?.label ?? "Efekt"} başlatıldı.${upgraded}${skipped}`);
  }

  function stop() {
    setPickerOpen(false);
    if (isEmptyPlan(stopPlan)) return;
    stopEffect(stopPlan);
    say("Efekt durduruldu; lambalar son şiddetine döndü.");
  }

  // Aynı seçim için ileri bir saate zamanlama (Aç varsayılan, formda değişir).
  function schedule() {
    openSchedule({
      prefill: { action: "on", selection: new Map(selection) },
      onSaved: (s) =>
        say(s.nextRunAt ? `Zamanlandı · ilk çalışma ${formatRunAt(new Date(s.nextRunAt))}.` : "Zamanlandı."),
    });
  }

  const btn =
    "inline-flex cursor-pointer h-9 items-center justify-center rounded-[10px] border border-border px-3.5 text-[13.5px] font-medium text-text transition-colors hover:border-border-strong hover:bg-panel-2";

  return (
    <>
      <div
        role="region"
        aria-label="Seçili cihazlar için işlemler"
        className="sticky bottom-4 z-30 flex flex-col gap-2 rounded-2xl border border-border-strong bg-panel/95 px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,.18)] backdrop-blur sm:px-5"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <span className="text-sm font-semibold text-text">{what} seçildi</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => power(true)} className={btn}>
              Aç
            </button>
            <button type="button" onClick={() => power(false)} className={btn}>
              Kapat
            </button>
          </div>
          <div className="flex min-w-[200px] flex-1 items-center gap-3">
            <span className="text-[13px] text-ink-2">Şiddet</span>
            <div className="flex-1">
              <BrightnessSlider value={value} onChange={dim} label="Seçili cihazların ışık şiddeti" />
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPickerOpen(true)} className="btn-glow h-9 px-4 text-[13.5px]">
              Efekt
            </button>
            {!isEmptyPlan(stopPlan) ? (
              <button type="button" onClick={stop} className={btn}>
                Efekti durdur
              </button>
            ) : null}
            <button
              type="button"
              onClick={schedule}
              title="Seçili cihazlar için ileri bir saate zamanla"
              className={`${btn} gap-1.5`}
            >
              <ClockIcon />
              Zamanla
            </button>
            <button
              type="button"
              onClick={onClear}
              aria-label="Seçimi temizle"
              title="Seçimi temizle"
              className="grid h-9 w-9 place-items-center rounded-[10px] text-muted transition-colors hover:bg-panel-2 hover:text-text"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {notice?.sig === sig ? (
          <p aria-live="polite" className="text-[12.5px] text-ok">
            {notice.text}
          </p>
        ) : null}
      </div>

      <EffectPicker
        open={pickerOpen}
        title={`${what} · Efektler`}
        activeFx={activeFx}
        lampCount={single?.lampCount || undefined}
        onClose={() => setPickerOpen(false)}
        onPick={pickEffect}
        onStop={stop}
      />
    </>
  );
}
