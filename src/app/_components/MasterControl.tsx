"use client";

import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";

interface MasterControlProps {
  anyOn: boolean;
  masterBrightness: number;
  onSetAll: (on: boolean) => void;
  onSetAllBrightness: (value: number) => void;
}

export function MasterControl({
  anyOn,
  masterBrightness,
  onSetAll,
  onSetAllBrightness,
}: MasterControlProps) {
  const lvl = anyOn ? masterBrightness / 100 : 0;

  return (
    <section
      aria-label="Tüm sistem kontrolü"
      className="glow-spill rounded-3xl border border-border bg-panel p-5 sm:p-6"
      style={
        {
          "--lvl": lvl,
          "--spread": "40px",
        } as React.CSSProperties
      }
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Tüm Sistem
          </p>
          <h2 className="mt-1 font-display text-xl font-bold text-text sm:text-2xl">
            {anyOn ? "Aydınlatma açık" : "Aydınlatma kapalı"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Tek dokunuşla tüm zonları aç/kapat veya genel şiddeti ayarla.
          </p>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto">
          <span className="text-sm font-medium text-muted">
            {anyOn ? "Açık" : "Kapalı"}
          </span>
          <Toggle
            checked={anyOn}
            onChange={onSetAll}
            label="Tüm sistemi aç/kapat"
            size="lg"
          />
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <div className="mb-3 flex items-center justify-between">
          <label className="text-sm font-medium text-text">Genel Şiddet</label>
        </div>
        <BrightnessSlider
          value={masterBrightness}
          onChange={onSetAllBrightness}
          disabled={!anyOn}
          label="Genel ışık şiddeti"
          size="lg"
        />
      </div>
    </section>
  );
}
