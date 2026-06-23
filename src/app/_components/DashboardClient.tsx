"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Zone, ZoneStatus } from "@/app/_lib/types";
import { summarize } from "@/app/_lib/mockData";
import type { Action, LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { StatusOverview } from "./StatusOverview";
import { MasterControl } from "./MasterControl";
import { ZoneGrid } from "./ZoneGrid";

async function sendCommand(zoneId: string, action: Action, value?: number) {
  const res = await fetch(`/api/zones/${zoneId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
}

export function DashboardClient({ initialZones }: { initialZones: Zone[] }) {
  const [zones, setZones] = useState<Zone[]>(initialZones);
  const [masterBrightness, setMasterBrightness] = useState(72);

  // Parlaklık komutları için zone başına debounce zamanlayıcıları.
  const dimTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const summary = useMemo(() => summarize(zones), [zones]);
  const anyOn = useMemo(() => zones.some((z) => z.isOn), [zones]);

  // ── Canlı durum (SSE) ──────────────────────────────────────
  const onLive = useCallback((e: LiveEvent) => {
    if (!e.zoneSlug) return;
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== e.zoneSlug) return z;
        const next: Zone = { ...z };
        if (typeof e.isOn === "boolean") next.isOn = e.isOn;
        if (typeof e.brightness === "number") next.brightness = e.brightness;
        // status'u yalnızca gerçek cihaz mesajından uygula (optimistic ezmesin).
        if (e.deviceId) next.status = (e.status === "error" ? "fault" : "ok") as ZoneStatus;
        return next;
      }),
    );
  }, []);

  useLiveStatus(onLive);

  // ── Aksiyonlar (optimistic + API) ──────────────────────────
  function toggleZone(id: string, on: boolean) {
    const prev = zones;
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, isOn: on } : z)));
    sendCommand(id, on ? "on" : "off").catch(() => setZones(prev)); // hata → geri al
  }

  function setZoneBrightness(id: string, value: number) {
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, brightness: value } : z)));

    // Sürükleme boyunca akışı boğmamak için debounce'la (son değeri gönder).
    const timers = dimTimers.current;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        sendCommand(id, "dim", value).catch(() => {});
        timers.delete(id);
      }, 300),
    );
  }

  function setAll(on: boolean) {
    setZones((zs) => zs.map((z) => ({ ...z, isOn: on })));
    // Kural #3: her zone'a tek komut.
    for (const z of zones) sendCommand(z.id, on ? "on" : "off").catch(() => {});
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value);
    setZones((zs) => zs.map((z) => ({ ...z, brightness: value })));
    const timers = dimTimers.current;
    clearTimeout(timers.get("__all__"));
    timers.set(
      "__all__",
      setTimeout(() => {
        for (const z of zones) sendCommand(z.id, "dim", value).catch(() => {});
        timers.delete("__all__");
      }, 300),
    );
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
