"use client";

import { useEffect, useRef, useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { deviceHealth, formatAgo, formatPower, formatVolt } from "@/app/_lib/deviceHealth";
import { describeDeviceError } from "@/lib/deviceErrors";
import { formatMac } from "@/lib/mac";
import { useDialogs } from "../PanelDialogs";
import { StatusLabel } from "../PanelUi";

/** Satır sonundaki "···" menüsü: düzenle / sil. */
function RowMenu({ device }: { device: DeviceView }) {
  const { openDeviceForm, confirmDeleteDevice, openDevice } = useDialogs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "block w-full px-3.5 py-2 text-left text-sm transition-colors";
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${device.name || formatMac(device.deviceId)} işlemleri`}
        className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-muted transition-colors hover:bg-panel-2 hover:text-text"
      >
        ···
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-panel py-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            className={`${item} text-text hover:bg-panel-2`}
            onClick={() => {
              setOpen(false);
              openDevice(device);
            }}
          >
            Kontrol ve telemetri
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} text-text hover:bg-panel-2`}
            onClick={() => {
              setOpen(false);
              openDeviceForm({ device });
            }}
          >
            Bölge / isim düzenle
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${item} text-danger hover:bg-danger-soft`}
            onClick={() => {
              setOpen(false);
              confirmDeleteDevice(device);
            }}
          >
            Sil
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Cihaz tablosu — Cihazlar sayfası ve bölge detayı. Satıra tıklayınca cihaz
 * paneli (kontrol / D4i telemetrisi / arıza geçmişi) açılır. Güç ve gerilim
 * cihazın son 10 dakikadaki D4i raporlarından (`/api/summary` cihaz kırılımı).
 */
export function DeviceTable({
  devices,
  showZone = false,
  showLevel = false,
}: {
  devices: DeviceView[];
  /** Bölge sütunu (tüm cihazlar listesinde). */
  showZone?: boolean;
  /** Şiddet sütunu: cihazın bölgesinin son komutu. */
  showLevel?: boolean;
}) {
  const { zones, live, faultsByDevice } = useLighting();
  const { canWrite } = usePanel();
  const { openDevice } = useDialogs();
  const now = useNow(5_000);

  const th = "px-3 py-3 text-left font-semibold first:pl-[22px] last:pr-[22px]";
  const td = "px-3 py-[14px] align-middle first:pl-[22px] last:pr-[22px]";

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead className="table-head">
          <tr>
            <th className={th}>Cihaz</th>
            <th className={th}>MAC</th>
            {showZone ? <th className={th}>Bölge</th> : null}
            <th className={th}>Durum</th>
            {showLevel ? <th className={th}>Şiddet</th> : null}
            <th className={th}>Güç</th>
            <th className={th}>Gerilim</th>
            <th className={th}>Son veri</th>
            {canWrite ? <th className={`${th} w-12`}><span className="sr-only">İşlemler</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const m = live?.devices?.[d.deviceId];
            const faults = faultsByDevice.get(d.deviceId);
            const health = deviceHealth(d, { faults, measure: m, now });
            const zone = zones.find((z) => z.id === d.zoneSlug);
            const measured = m?.powerW != null;
            const valueCls = measured ? "text-text" : "text-muted";
            const title = d.name || formatMac(d.deviceId);
            return (
              <tr
                key={d.id}
                onClick={() => openDevice(d)}
                className="cursor-pointer border-t border-border transition-colors hover:bg-panel-2/60"
              >
                <td className={td}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDevice(d);
                    }}
                    className="flex flex-col items-start gap-0.5 text-left"
                  >
                    <span className="font-semibold text-text hover:text-accent">{title}</span>
                    {faults?.length ? (
                      <span className="text-xs text-danger">
                        {[...new Set(faults.map((f) => f.channel))]
                          .map((ch) => `Lamba ${ch}`)
                          .join(", ")}
                      </span>
                    ) : d.lastError ? (
                      <span className="text-xs text-danger">{describeDeviceError(d.lastError).title}</span>
                    ) : m ? (
                      <span className="text-xs text-muted">{m.lamps} lamba raporluyor</span>
                    ) : null}
                  </button>
                </td>
                <td className={`${td} font-mono text-[13px] text-ink-2`}>{formatMac(d.deviceId)}</td>
                {showZone ? <td className={`${td} text-ink-2`}>{d.zoneName ?? "—"}</td> : null}
                <td className={td}>
                  <StatusLabel tone={health.tone} label={health.label} />
                </td>
                {showLevel ? (
                  <td className={`${td} font-mono text-[13px] text-accent`}>
                    {zone ? (zone.isOn ? `%${zone.brightness}` : "kapalı") : "—"}
                  </td>
                ) : null}
                <td className={`${td} font-mono text-[13px] ${valueCls}`}>
                  {m?.powerW != null ? formatPower(m.powerW) : "—"}
                </td>
                <td className={`${td} font-mono text-[13px] ${m?.ledVoltageV != null ? "text-text" : "text-muted"}`}>
                  {m?.ledVoltageV != null ? formatVolt(m.ledVoltageV, m.ledVoltageEstimated) : "—"}
                </td>
                <td className={`${td} text-[13px] text-muted`}>{formatAgo(d.lastSeen, now)}</td>
                {canWrite ? (
                  <td className={td}>
                    <RowMenu device={d} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
