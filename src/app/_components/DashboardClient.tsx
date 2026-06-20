"use client";

import { useMemo, useState } from "react";
import type { Zone } from "@/app/_lib/types";
import { summarize } from "@/app/_lib/mockData";
import { StatusOverview } from "./StatusOverview";
import { MasterControl } from "./MasterControl";
import { ZoneGrid } from "./ZoneGrid";

export function DashboardClient({ initialZones }: { initialZones: Zone[] }) {
  const [zones, setZones] = useState<Zone[]>(initialZones);
  const [masterBrightness, setMasterBrightness] = useState(72);

  // Özet metrikler her zaman güncel zon durumundan türetilir.
  const summary = useMemo(() => summarize(zones), [zones]);
  const anyOn = useMemo(() => zones.some((z) => z.isOn), [zones]);

  function toggleZone(id: string, on: boolean) {
    setZones((prev) =>
      prev.map((z) => (z.id === id ? { ...z, isOn: on } : z)),
    );
  }

  function setZoneBrightness(id: string, value: number) {
    setZones((prev) =>
      prev.map((z) => (z.id === id ? { ...z, brightness: value } : z)),
    );
  }

  function setAll(on: boolean) {
    setZones((prev) => prev.map((z) => ({ ...z, isOn: on })));
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value);
    setZones((prev) => prev.map((z) => ({ ...z, brightness: value })));
  }

  return (
    <div className="flex flex-col gap-6">
      <StatusOverview summary={summary} />
      <MasterControl
        anyOn={anyOn}
        masterBrightness={masterBrightness}
        onSetAll={setAll}
        onSetAllBrightness={setAllBrightness}
      />
      <ZoneGrid
        zones={zones}
        onToggle={toggleZone}
        onBrightness={setZoneBrightness}
      />
    </div>
  );
}
