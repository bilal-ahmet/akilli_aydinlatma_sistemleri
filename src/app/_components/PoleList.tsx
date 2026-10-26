"use client";

import { useState } from "react";
import type { PoleView, Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { deviceName } from "@/app/_lib/format";
import { lampOn } from "@/app/_lib/selection";
import { POLE_STATE_DOT, POLE_STATE_LABELS, poleStateResolver } from "@/app/_lib/poles";
import { useDialogs } from "./PanelDialogs";
import { Pager, pageSlice } from "./PanelUi";
import { RowMenu } from "./RowMenu";

const PAGE_SIZE = 20;

/** Satır sonundaki "···" menüsü: düzenle / sil. */
function PoleRowMenu({ pole }: { pole: PoleView }) {
  const { openPoleForm, confirmDeletePole } = useDialogs();
  return (
    <RowMenu
      label={`${pole.code} işlemleri`}
      width={160}
      items={[
        { label: "Düzenle", onSelect: () => openPoleForm(pole) },
        { label: "Sil", danger: true, onSelect: () => confirmDeletePole(pole) },
      ]}
    />
  );
}

/**
 * Bölgenin direkleri: durum, numara, takılı cihaz, lamba özeti ve konum.
 * Durum bağlı cihazdan türetilir (`poleState`) ve SSE ile canlı güncellenir.
 */
export function PoleList({ zone }: { zone: Zone }) {
  const { poles, devices, faultsByDevice, polesLoading } = useLighting();
  const { canWrite } = usePanel();
  const technical = useTechnical();
  const { openPoleForm, openPoleImport, openDevice } = useDialogs();
  const now = useNow(15_000);
  const [pageIndex, setPageIndex] = useState(0);

  const zonePoles = poles.filter((p) => p.zoneSlug === zone.id);
  const stateOf = poleStateResolver(devices, faultsByDevice, now);
  const byMac = new Map(devices.map((d) => [d.deviceId, d]));
  const unlocated = zonePoles.filter((p) => p.lat === null).length;
  const { page, rows } = pageSlice(zonePoles, pageIndex, PAGE_SIZE);

  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-panel">
      <div className="flex items-center justify-between gap-2 px-[22px] py-[18px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-base font-semibold text-text">
            Direkler <span className="font-normal text-muted">· {zonePoles.length}</span>
          </h2>
          {unlocated > 0 ? (
            <p className="text-[12.5px] text-muted">{unlocated} direğin konumu henüz girilmedi.</p>
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex shrink-0 gap-4">
            <button
              type="button"
              onClick={() => openPoleImport(zone.id)}
              className="text-[13px] font-medium text-ink-2 hover:text-text hover:underline"
            >
              İçe aktar
            </button>
            <button
              type="button"
              onClick={() => openPoleForm(undefined, { zoneSlug: zone.id })}
              className="text-[13px] font-medium text-accent hover:underline"
            >
              + Direk ekle
            </button>
          </div>
        ) : null}
      </div>

      {zonePoles.length === 0 ? (
        <p className="border-t border-border px-[22px] py-6 text-sm text-muted">
          {polesLoading
            ? "Yükleniyor…"
            : `Bu bölgede kayıtlı direk yok.${canWrite ? " “+ Direk ekle” ile direkleri numarası ve konumuyla ekleyebilirsiniz." : ""}`}
        </p>
      ) : (
        <>
          <ul className="border-t border-border">
            {rows.map((p) => {
              const state = stateOf(p);
              const device = p.deviceId ? byMac.get(p.deviceId) : undefined;
              const lit = device ? device.lamps.filter(lampOn).length : 0;
              return (
                <li
                  key={p.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-[22px] py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]"
                >
                  <span
                    aria-hidden
                    title={POLE_STATE_LABELS[state]}
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${POLE_STATE_DOT[state]}`}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold text-text">
                      {p.code}
                      {p.name ? <span className="font-normal text-muted"> · {p.name}</span> : null}
                    </span>
                    <span className="text-[12px] text-muted">{POLE_STATE_LABELS[state]}</span>
                  </span>
                  <span className="order-last col-span-3 min-w-0 pl-[22px] text-[13px] sm:order-none sm:col-span-1 sm:pl-0">
                    {device ? (
                      <button
                        type="button"
                        onClick={() => openDevice(device)}
                        className="truncate text-left text-text hover:text-accent hover:underline"
                      >
                        {deviceName(device, technical)}
                        <span className="text-muted">
                          {device.lamps.length > 0 ? ` · ${lit}/${device.lamps.length} lamba yanıyor` : ""}
                        </span>
                      </button>
                    ) : (
                      <span className="text-muted">Cihaz takılı değil</span>
                    )}
                  </span>
                  <span className="hidden text-[13px] sm:block">
                    {p.lat !== null ? (
                      <span className="text-ink-2">Konum girildi</span>
                    ) : (
                      <span className="text-muted">Konum yok</span>
                    )}
                  </span>
                  {canWrite ? <PoleRowMenu pole={p} /> : <span />}
                </li>
              );
            })}
          </ul>
          <Pager page={page} pageSize={PAGE_SIZE} total={zonePoles.length} onPage={setPageIndex} label="Direk sayfaları" />
        </>
      )}
    </section>
  );
}
