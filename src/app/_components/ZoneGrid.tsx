"use client";

import type { OpenFault, Zone } from "@/app/_lib/types";
import { ZoneCard } from "./ZoneCard";

interface ZoneGridProps {
  zones: Zone[];
  /** Bölge slug'ı → o bölgede süren lamba arızaları. */
  faultsByZone: Map<string, OpenFault[]>;
  onToggle: (id: string, on: boolean) => void;
  onBrightness: (id: string, value: number) => void;
  onCreate: () => void;
  onEffect: (zone: Zone) => void;
  onEdit: (zone: Zone) => void;
  onDelete: (zone: Zone) => void;
}

export function ZoneGrid({
  zones,
  faultsByZone,
  onToggle,
  onBrightness,
  onCreate,
  onEffect,
  onEdit,
  onDelete,
}: ZoneGridProps) {
  return (
    <section aria-label="Aydınlatma bölgeleri">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg font-bold text-text">Bölgeler</h2>
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
          Yeni Bölge
        </button>
      </div>

      {zones.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-panel/50 p-8 text-center text-sm text-muted">
          Henüz bölge yok. “Yeni Bölge” ile ekleyebilirsin.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((zone) => (
            <ZoneCard
              key={zone.id}
              zone={zone}
              faults={faultsByZone.get(zone.id) ?? []}
              onToggle={(on) => onToggle(zone.id, on)}
              onBrightness={(value) => onBrightness(zone.id, value)}
              onEffect={() => onEffect(zone)}
              onEdit={() => onEdit(zone)}
              onDelete={() => onDelete(zone)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
