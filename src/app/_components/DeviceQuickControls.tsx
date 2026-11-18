"use client";

import { useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { deviceName } from "@/app/_lib/format";
import { deviceState } from "@/app/_lib/selection";
import { effectByNumber } from "@/lib/effects";
import { BrightnessSlider } from "./BrightnessSlider";
import { EffectPicker } from "./EffectPicker";
import { Toggle } from "./Toggle";

/**
 * Tek cihazın hızlı kontrolü: aç/kapa, şiddet, efekt başlat/durdur. Komutlar
 * cihazın tamamına (kanalsız) gider — `LightingProvider` üzerinden, yani
 * optimistic durum, cihaz sırası ve grup efekti durdurma kuralları toplu
 * kontrolle aynıdır. Armatür bazında kontrol cihaz panelindedir.
 *
 * - `row`: cihaz tablosu satırı (anahtar · kısa kaydırıcı · efekt düğmesi).
 *   Tıklamalar satıra kabarcıklanmaz (satır tıklaması cihaz panelini açar).
 * - `panel`: harita yan paneli (Aç / Kapat düğmeleri, tam genişlik kaydırıcı,
 *   Efekt / Efekti durdur).
 *
 * Yazma yetkisi yoksa hiçbir şey çizmez (asıl yetki sunucuda).
 */
export function DeviceQuickControls({
  device,
  variant,
}: {
  device: DeviceView;
  variant: "row" | "panel";
}) {
  const { setTargetsPower, setTargetsBrightness, applyEffect, stopEffect } = useLighting();
  const { canWrite } = usePanel();
  const technical = useTechnical();
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!canWrite) return null;

  const target = { devices: [device.deviceId] };
  const light = deviceState(device);
  const fx = effectByNumber(light.activeFx);
  const title = deviceName(device, technical);
  const level = light.isOn ? light.brightness : 0;

  const power = (on: boolean) => setTargetsPower(target, on);
  const dim = (v: number) => setTargetsBrightness(target, v);
  const stop = () => {
    setPickerOpen(false);
    stopEffect(target);
  };

  const picker = (
    <EffectPicker
      open={pickerOpen}
      title={`${title} · Efektler`}
      activeFx={light.activeFx}
      lampCount={device.lampCount || undefined}
      onClose={() => setPickerOpen(false)}
      onPick={(number, text) => {
        setPickerOpen(false);
        applyEffect(target, number, text);
      }}
      onStop={stop}
    />
  );

  if (variant === "row") {
    const btn =
      "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-[9px] border border-border px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-border-strong hover:bg-panel hover:text-text";
    return (
      // Cihaz bilgisinin hemen altındaki kontrol şeridi. Kendi satırındadır;
      // tıklamalar cihaz panelini açmaz. (Klavye olayları durdurulmaz: efekt
      // seçicinin Escape'i window'da dinlenir.)
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-panel-2/70 px-3.5 py-2"
        onClick={(e) => e.stopPropagation()}
        role="group"
        aria-label={`${title} kontrolü`}
      >
        <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-ink-2">
          <Toggle checked={light.isOn === true} onChange={power} label={`${title} aç/kapat`} />
          <span className="w-[42px]">{light.isOn ? "Açık" : "Kapalı"}</span>
        </label>
        <div className="flex min-w-[200px] max-w-[420px] flex-1 items-center gap-3">
          <span className="text-[12.5px] text-ink-2">Şiddet</span>
          <div className="flex-1">
            <BrightnessSlider value={level} onChange={dim} label={`${title} ışık şiddeti`} />
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setPickerOpen(true)} className={btn}>
            <span aria-hidden className="mr-1 text-accent">✦</span>
            {fx ? fx.label : "Efekt"}
          </button>
          {fx ? (
            <button type="button" onClick={stop} className={btn}>
              Efekti durdur
            </button>
          ) : null}
        </div>
        {picker}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => power(true)}
          className={`btn-line h-9 flex-1 text-[13px] ${light.isOn ? "!border-glow/60 !text-text" : ""}`}
        >
          Aç
        </button>
        <button
          type="button"
          onClick={() => power(false)}
          className={`btn-line h-9 flex-1 text-[13px] ${light.isOn === false ? "!border-border-strong !text-text" : ""}`}
        >
          Kapat
        </button>
      </div>
      <BrightnessSlider value={level} onChange={dim} label={`${title} ışık şiddeti`} />
      <div className="flex gap-2">
        <button type="button" onClick={() => setPickerOpen(true)} className="btn-glow h-9 flex-1 text-[13px]">
          {fx ? `✦ ${fx.label}` : "Efekt"}
        </button>
        {fx ? (
          <button type="button" onClick={stop} className="btn-line h-9 flex-1 text-[13px]">
            Efekti durdur
          </button>
        ) : null}
      </div>
      {picker}
    </section>
  );
}
