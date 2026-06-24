"use client";

import type { Zone } from "@/app/_lib/types";
import { formatInt, formatKw } from "@/app/_lib/format";
import { zonePowerKw } from "@/app/_lib/mockData";
import { effectByNumber } from "@/lib/effects";
import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";

interface ZoneCardProps {
  zone: Zone;
  onToggle: (on: boolean) => void;
  onBrightness: (value: number) => void;
  onEffect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

const STATUS: Record<Zone["status"], { label: string; cls: string }> = {
  ok: { label: "Çalışıyor", cls: "text-muted" },
  warning: { label: "Uyarı", cls: "text-glow" },
  fault: { label: "Arıza", cls: "text-danger" },
};

export function ZoneCard({ zone, onToggle, onBrightness, onEffect, onEdit, onDelete }: ZoneCardProps) {
  const lvl = zone.isOn ? zone.brightness / 100 : 0;
  const status = STATUS[zone.status];
  const activeEffect = effectByNumber(zone.activeFx);

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
        <div className="flex items-center gap-2">
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
          {activeEffect ? (
            <span
              title={activeEffect.desc}
              className="inline-flex items-center gap-1 rounded-full border border-glow/40 bg-glow/15 px-2 py-0.5 font-medium text-accent"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
              </svg>
              {activeEffect.label}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono tabular-nums text-muted">
            {zone.isOn ? formatKw(zonePowerKw(zone)) : "0,0 kW"}
          </span>
          <button
            type="button"
            onClick={onEffect}
            aria-label={`${zone.name} efektleri`}
            title="Efektler"
            className="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-accent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`${zone.name} düzenle`}
            title="Düzenle"
            className="rounded-md p-1 text-muted transition-colors hover:bg-panel-2 hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`${zone.name} sil`}
            title="Sil"
            className="rounded-md p-1 text-muted transition-colors hover:bg-danger/15 hover:text-danger"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
        </div>
      </div>
    </article>
  );
}
