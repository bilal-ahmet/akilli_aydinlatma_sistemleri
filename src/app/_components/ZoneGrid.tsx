"use client";

import type { Zone } from "@/app/_lib/types";
import { ZoneCard } from "./ZoneCard";

interface ZoneGridProps {
  zones: Zone[];
  onToggle: (id: string, on: boolean) => void;
  onBrightness: (id: string, value: number) => void;
}

export function ZoneGrid({ zones, onToggle, onBrightness }: ZoneGridProps) {
  return (
    <section aria-label="Aydınlatma zonları">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold text-text">Zonlar</h2>
        <p className="text-xs text-muted">{zones.length} cadde / sokak</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {zones.map((zone) => (
          <ZoneCard
            key={zone.id}
            zone={zone}
            onToggle={(on) => onToggle(zone.id, on)}
            onBrightness={(value) => onBrightness(zone.id, value)}
          />
        ))}
      </div>
    </section>
  );
}
