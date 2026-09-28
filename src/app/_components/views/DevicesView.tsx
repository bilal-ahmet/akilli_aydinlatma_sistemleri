"use client";

import { useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { isOnline } from "@/app/_lib/deviceHealth";
import { formatMac } from "@/lib/mac";
import { useDialogs } from "../PanelDialogs";
import { EmptyBox, PageHeader, PlusIcon } from "../PanelUi";
import { DeviceTable } from "./DeviceTable";

/** Aramada MAC iki noktalı/noktasız, büyük/küçük harf fark etmez. */
function normalize(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/[:\-\s]/g, "");
}

export function DevicesView() {
  const { zones, devices, devicesLoading } = useLighting();
  const { canWrite } = usePanel();
  const { openDeviceForm } = useDialogs();
  const now = useNow(15_000);
  const [query, setQuery] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);

  const q = normalize(query);
  const matchesQuery = (d: (typeof devices)[number]) =>
    !q ||
    normalize(d.deviceId).includes(q) ||
    normalize(formatMac(d.deviceId)).includes(q) ||
    (d.name ? normalize(d.name).includes(q) : false);

  const searched = devices.filter(matchesQuery);
  const visible = zoneFilter ? searched.filter((d) => d.zoneSlug === zoneFilter) : searched;

  const zoneCount = new Set(devices.map((d) => d.zoneSlug).filter(Boolean)).size;
  const online = devices.filter((d) => isOnline(d, now)).length;
  const subtitle =
    devices.length === 0
      ? "Henüz cihaz yok"
      : `${zoneCount} bölgede ${devices.length} ESP32` +
        (now === null
          ? ""
          : online === devices.length
            ? " · tümü çevrimiçi"
            : ` · ${online} çevrimiçi`);

  const chip = (active: boolean) =>
    `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors ${
      active
        ? "bg-text font-medium text-bg"
        : "border border-border text-ink-2 hover:border-border-strong hover:text-text"
    }`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Cihazlar"
        subtitle={subtitle}
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={() => openDeviceForm()}
              disabled={zones.length === 0}
              title={zones.length === 0 ? "Önce bir bölge oluşturun" : undefined}
              className="btn-glow h-[38px] px-4 text-sm"
            >
              <PlusIcon />
              Yeni Cihaz
            </button>
          ) : null
        }
      />

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="İsim veya MAC ara"
          aria-label="İsim veya MAC ara"
          className="field !h-[38px] md:!w-[280px]"
        />
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Bölge filtresi">
          <button type="button" onClick={() => setZoneFilter(null)} className={chip(zoneFilter === null)} aria-pressed={zoneFilter === null}>
            Tümü <span className="opacity-60">{searched.length}</span>
          </button>
          {zones.map((z) => {
            const n = searched.filter((d) => d.zoneSlug === z.id).length;
            const active = zoneFilter === z.id;
            return (
              <button
                key={z.id}
                type="button"
                onClick={() => setZoneFilter(active ? null : z.id)}
                aria-pressed={active}
                className={chip(active)}
              >
                {z.name} <span className={active ? "opacity-60" : "text-muted"}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {devicesLoading ? (
        <EmptyBox>Yükleniyor…</EmptyBox>
      ) : devices.length === 0 ? (
        <EmptyBox>
          Henüz cihaz yok.
          {canWrite
            ? " Gerçek ESP32'yi bağlamadan önce “Yeni Cihaz” ile MAC adresini ve bölgesini tanımlayın."
            : ""}
        </EmptyBox>
      ) : visible.length === 0 ? (
        <EmptyBox>Aramanızla eşleşen cihaz yok.</EmptyBox>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-panel">
          <DeviceTable devices={visible} showZone showLevel />
        </div>
      )}

      <p className="text-[12.5px] text-muted">
        “Veri bekleniyor”: cihaz bağlı, ancak son 10 dakikada gerilim ve güç bilgisi göndermedi.
        Şiddet, cihazın bölgesine giden son komuttur.
      </p>
    </div>
  );
}
