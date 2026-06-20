"use client";

import type { Zone } from "@/app/_lib/types";
import { formatInt, formatKw } from "@/app/_lib/format";
import { zonePowerKw } from "@/app/_lib/mockData";
import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";

interface ZoneCardProps {
  zone: Zone;
  onToggle: (on: boolean) => void;
  onBrightness: (value: number) => void;
}

const STATUS: Record<Zone["status"], { label: string; cls: string }> = {
  ok: { label: "Çalışıyor", cls: "text-muted" },
  warning: { label: "Uyarı", cls: "text-glow" },
  fault: { label: "Arıza", cls: "text-danger" },
};

export function ZoneCard({ zone, onToggle, onBrightness }: ZoneCardProps) {
  const lvl = zone.isOn ? zone.brightness / 100 : 0;
  const status = STATUS[zone.status];

  return (
    <article
      className={`glow-spill flex flex-col rounded-2xl border bg-panel p-4 transition-colors ${
        zone.isOn ? "border-glow/30" : "border-border"
      }`}
      style={
        {
          "--lvl": lvl * 0.7,
          "--spread": "20px",
        } as React.CSSProperties
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-base font-semibold text-text">
            {zone.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {zone.district} · {formatInt(zone.poleCount)} direk
          </p>
        </div>
        <Toggle
          checked={zone.isOn}
          onChange={onToggle}
          label={`${zone.name} aç/kapat`}
        />
      </div>

      <div className="mt-4">
        <BrightnessSlider
          value={zone.brightness}
          onChange={onBrightness}
          disabled={!zone.isOn}
          label={`${zone.name} ışık şiddeti`}
        />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs">
        <span className={`flex items-center gap-1.5 font-medium ${status.cls}`}>
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${
              zone.status === "ok"
                ? "bg-muted"
                : zone.status === "warning"
                  ? "bg-glow"
                  : "bg-danger"
            }`}
          />
          {status.label}
        </span>
        <span className="font-mono tabular-nums text-muted">
          {zone.isOn ? formatKw(zonePowerKw(zone)) : "0,0 kW"}
        </span>
      </div>
    </article>
  );
}
