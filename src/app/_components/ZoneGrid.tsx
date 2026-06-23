"use client";

import type { Zone } from "@/app/_lib/types";
import { ZoneCard } from "./ZoneCard";

interface ZoneGridProps {
  zones: Zone[];
  onToggle: (id: string, on: boolean) => void;
  onBrightness: (id: string, value: number) => void;
  onCreate: () => void;
  onEdit: (zone: Zone) => void;
  onDelete: (zone: Zone) => void;
}

export function ZoneGrid({
  zones,
  onToggle,
  onBrightness,
  onCreate,
  onEdit,
  onDelete,
}: ZoneGridProps) {
  return (
    <section aria-label="Aydınlatma zonları">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg font-bold text-text">Zonlar</h2>
          <p className="text-xs text-muted">{zones.length} cadde / sokak</p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Yeni Zone
        </button>
      </div>

      {zones.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-panel/50 p-8 text-center text-sm text-muted">
          Henüz zone yok. “Yeni Zone” ile ekleyebilirsin.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((zone) => (
            <ZoneCard
              key={zone.id}
              zone={zone}
              onToggle={(on) => onToggle(zone.id, on)}
              onBrightness={(value) => onBrightness(zone.id, value)}
              onEdit={() => onEdit(zone)}
              onDelete={() => onDelete(zone)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
