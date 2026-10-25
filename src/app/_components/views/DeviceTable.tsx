"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { DeviceView, LampView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { deviceHealth, formatAgo, formatPower, formatVolt } from "@/app/_lib/deviceHealth";
import { describeDeviceError } from "@/lib/deviceErrors";
import { effectByNumber } from "@/lib/effects";
import { formatMac } from "@/lib/mac";
import { deviceName } from "@/app/_lib/format";
import { isLit } from "@/app/_lib/mockData";
import {
  deviceSelState,
  deviceState,
  isLampSelected,
  lampName,
  lampOn,
  replaceWithin,
  toggleDevice,
  toggleLamp,
  type Selection,
} from "@/app/_lib/selection";
import { useDialogs } from "../PanelDialogs";
import { StatusLabel } from "../PanelUi";

/** Satır sonundaki "···" menüsü: düzenle / sil. */
function RowMenu({ device }: { device: DeviceView }) {
  const { technical } = usePanel();
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
        aria-label={`${deviceName(device, technical)} işlemleri`}
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
            {technical ? "Kontrol ve telemetri" : "Kontrol ve ölçümler"}
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
            Düzenle
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

const checkbox =
  "h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--acc)] align-middle";

/** Işık durumu metni: "✦ Dalga", "%60", "kapalı", bilinmiyorsa "—". */
function lightText(s: { isOn: boolean | null; brightness: number; activeFx: number | null }) {
  const fx = s.activeFx != null ? effectByNumber(s.activeFx) : undefined;
  if (fx) return { text: `✦ ${fx.label}`, cls: "text-accent" };
  if (s.isOn === null) return { text: "—", cls: "text-muted" };
  return s.isOn ? { text: `%${s.brightness}`, cls: "text-accent" } : { text: "kapalı", cls: "text-muted" };
}

/**
 * Cihaz tablosu — Cihazlar sayfası, bölge detayı ve Efektler sayfasının hedef
 * seçicisi. Satıra tıklayınca cihaz paneli (kontrol / ölçümler / arıza
 * geçmişi) açılır. Güç ve gerilim cihazın son 10 dakikadaki D4i raporlarından
 * (`/api/summary` cihaz kırılımı).
 *
 * `selection` + `onSelectionChange` verilirse seçim modu: onay kutuları ve
 * birden çok lambalı cihazda lamba alt satırları (tek tek lamba seçimi).
 * `compact` (hedef seçici penceresi): ölçüm sütunları ve satır menüsü gizlenir,
 * satıra tıklamak cihazı seçer.
 */
export function DeviceTable({
  devices,
  showZone = false,
  showLevel = false,
  selection,
  onSelectionChange,
  compact = false,
}: {
  devices: DeviceView[];
  /** Bölge sütunu (tüm cihazlar listesinde). */
  showZone?: boolean;
  /** Işık sütunu: cihazın lambalarının açık/şiddet/efekt durumu. */
  showLevel?: boolean;
  selection?: Selection;
  onSelectionChange?: (next: Selection) => void;
  compact?: boolean;
}) {
  const { zones, live, faultsByDevice } = useLighting();
  const { canWrite, technical } = usePanel();
  const { openDevice } = useDialogs();
  const now = useNow(5_000);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const selectable = canWrite && selection !== undefined && onSelectionChange !== undefined;
  const sel = selection ?? new Map();
  const select = (next: Selection) => onSelectionChange?.(next);
  const showLight = showLevel || selectable;
  const full = !compact;

  const th = "px-3 py-3 text-left font-semibold first:pl-[22px] last:pr-[22px]";
  const td = "px-3 py-[14px] align-middle first:pl-[22px] last:pr-[22px]";
  // Lamba alt satırının sütun yerleşimi: ad, Cihaz…Durum sütunlarını kaplar;
  // ışık durumu Işık sütununa hizalanır; kalan sütunlar boş geçilir.
  const nameSpan = 1 + (full ? 1 : 0) + (showZone ? 1 : 0) + 1;
  const restSpan = (full ? 3 : 0) + (canWrite && full ? 1 : 0);

  const allSelected = devices.length > 0 && devices.every((d) => deviceSelState(sel, d) === "all");
  const someSelected = devices.some((d) => deviceSelState(sel, d) !== "none");

  function toggleExpanded(mac: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(mac)) next.delete(mac);
      else next.add(mac);
      return next;
    });
  }

  /** Işık sütunu: lamba kaydı varsa lambalardan, yoksa bölgenin son komutundan. */
  function deviceLight(d: DeviceView) {
    if (d.lamps.length > 0) return lightText(deviceState(d));
    const zone = zones.find((z) => z.id === d.zoneSlug);
    if (!zone) return lightText({ isOn: null, brightness: 0, activeFx: null });
    return lightText({ isOn: isLit(zone), brightness: zone.brightness, activeFx: zone.activeFx ?? null });
  }

  return (
    <div className="relative overflow-x-auto">
      <table className={`w-full border-collapse text-sm ${full ? "min-w-[760px]" : ""}`}>
        <thead className="table-head">
          <tr>
            {selectable ? (
              <th className={`${th} w-12`}>
                <input
                  type="checkbox"
                  aria-label="Listedeki tüm cihazları seç"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={() => select(replaceWithin(sel, devices, () => !allSelected))}
                  className={checkbox}
                />
              </th>
            ) : null}
            <th className={th}>Cihaz</th>
            {full ? <th className={th}>{technical ? "MAC" : "Cihaz kodu"}</th> : null}
            {showZone ? <th className={th}>Bölge</th> : null}
            <th className={th}>Durum</th>
            {showLight ? <th className={th}>Işık</th> : null}
            {full ? (
              <>
                <th className={th}>Güç</th>
                <th className={th}>Gerilim</th>
                <th className={th}>Son bağlantı</th>
              </>
            ) : null}
            {canWrite && full ? (
              <th className={`${th} w-12`}>
                <span className="sr-only">İşlemler</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const m = live?.devices?.[d.deviceId];
            const faults = faultsByDevice.get(d.deviceId);
            const health = deviceHealth(d, { faults, measure: m, now });
            const measured = m?.powerW != null;
            const valueCls = measured ? "text-text" : "text-muted";
            const title = deviceName(d, technical);
            const state = deviceSelState(sel, d);
            const multiLamp = selectable && d.lamps.length > 1;
            const isOpen = multiLamp && expanded.has(d.deviceId);
            const light = deviceLight(d);
            const rowClick = () => (compact && selectable ? select(toggleDevice(sel, d)) : openDevice(d));
            return (
              <Fragment key={d.id}>
                <tr
                  onClick={rowClick}
                  aria-selected={selectable ? state !== "none" : undefined}
                  className={`cursor-pointer border-t border-border transition-colors hover:bg-panel-2/60 ${
                    state !== "none" ? "bg-glow/[.07]" : ""
                  }`}
                >
                  {selectable ? (
                    <td className={td} onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`${title} seç`}
                        checked={state === "all"}
                        ref={(el) => {
                          if (el) el.indeterminate = state === "some";
                        }}
                        onChange={() => select(toggleDevice(sel, d))}
                        className={checkbox}
                      />
                    </td>
                  ) : null}
                  <td className={td}>
                    <div className="flex flex-col items-start gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          rowClick();
                        }}
                        className="cursor-pointer whitespace-nowrap text-left font-semibold text-text transition-colors hover:text-accent"
                      >
                        {title}
                        {d.poleCode ? (
                          <span className="ml-1.5 text-xs font-normal text-muted">Direk {d.poleCode}</span>
                        ) : null}
                      </button>
                      {multiLamp || faults?.length || d.lastError || (m && full) ? (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          {multiLamp ? (
                            <LampToggle
                              open={isOpen}
                              label={
                                state === "some"
                                  ? `${(sel.get(d.deviceId) as Set<number>).size}/${d.lamps.length} lamba seçili`
                                  : `${d.lamps.length} lamba`
                              }
                              deviceTitle={title}
                              onToggle={() => toggleExpanded(d.deviceId)}
                            />
                          ) : null}
                          {faults?.length ? (
                            <span className="text-xs text-danger">
                              {[...new Set(faults.map((f) => f.channel))]
                                .map((ch) => `Lamba ${ch}`)
                                .join(", ")}
                            </span>
                          ) : d.lastError ? (
                            <span className="text-xs text-danger">
                              {describeDeviceError(d.lastError, { technical }).title}
                            </span>
                          ) : m && full && !multiLamp ? (
                            // Lamba düğmesi zaten lamba sayısını gösteriyorsa tekrar yazılmaz.
                            <span className="text-xs text-muted">
                              {technical ? `${m.lamps} lamba raporluyor` : `${m.lamps} lamba veri gönderiyor`}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </td>
                  {full ? (
                    <td className={`${td} font-mono text-[13px] text-ink-2`}>{formatMac(d.deviceId)}</td>
                  ) : null}
                  {showZone ? <td className={`${td} text-ink-2`}>{d.zoneName ?? "—"}</td> : null}
                  <td className={td}>
                    <StatusLabel tone={health.tone} label={health.label} />
                  </td>
                  {showLight ? (
                    <td
                      className={`${td} max-w-[150px] truncate whitespace-nowrap font-mono text-[13px] ${light.cls}`}
                      title={light.text}
                    >
                      {light.text}
                    </td>
                  ) : null}
                  {full ? (
                    <>
                      <td className={`${td} font-mono text-[13px] ${valueCls}`}>
                        {m?.powerW != null ? formatPower(m.powerW) : "—"}
                      </td>
                      <td
                        className={`${td} font-mono text-[13px] ${m?.ledVoltageV != null ? "text-text" : "text-muted"}`}
                      >
                        {m?.ledVoltageV != null ? formatVolt(m.ledVoltageV, m.ledVoltageEstimated) : "—"}
                      </td>
                      <td className={`${td} text-[13px] text-muted`}>{formatAgo(d.lastSeen, now)}</td>
                    </>
                  ) : null}
                  {canWrite && full ? (
                    <td className={td}>
                      <RowMenu device={d} />
                    </td>
                  ) : null}
                </tr>
                {isOpen
                  ? d.lamps.map((l) => (
                      <LampRow
                        key={`${d.id}:${l.channel}`}
                        lamp={l}
                        checked={isLampSelected(sel, d.deviceId, l.channel)}
                        onToggle={() => select(toggleLamp(sel, d, l.channel))}
                        technical={technical}
                        nameSpan={nameSpan}
                        restSpan={restSpan}
                        showLight={showLight}
                      />
                    ))
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Ampul ikonu (lamba düğmesi ve lamba satırları). */
function BulbIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" />
    </svg>
  );
}

/**
 * Çok lambalı cihazın lambalarını açan düğme — adın altında, çerçeveli ve
 * ikonlu: bir etiket değil, tıklanacak bir kontrol olduğu anlaşılsın.
 */
function LampToggle({
  open,
  label,
  deviceTitle,
  onToggle,
}: {
  open: boolean;
  label: string;
  deviceTitle: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      aria-label={`${deviceTitle} lambalarını ${open ? "gizle" : "göster"}`}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12px] font-medium transition-colors duration-150 ${
        open
          ? "border-glow/60 bg-glow/15 text-text"
          : "border-border bg-panel-2 text-ink-2 hover:border-glow/50 hover:bg-glow/10 hover:text-text"
      }`}
    >
      <BulbIcon className="text-accent" />
      {label}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

/**
 * Lamba alt satırı (seçim modunda): onay kutusu cihazlarınkiyle aynı sütunda,
 * ad cihaz adının hizasından girintili, ışık durumu Işık sütununda.
 */
function LampRow({
  lamp,
  checked,
  onToggle,
  technical,
  nameSpan,
  restSpan,
  showLight,
}: {
  lamp: LampView;
  checked: boolean;
  onToggle: () => void;
  technical: boolean;
  nameSpan: number;
  restSpan: number;
  showLight: boolean;
}) {
  const light = lightText({ ...lamp, isOn: lampOn(lamp) });
  return (
    <tr
      onClick={onToggle}
      aria-selected={checked}
      className={`cursor-pointer border-t border-border/60 text-[13px] transition-colors hover:bg-panel-2/60 ${
        checked ? "bg-glow/[.07]" : "bg-panel-2/40"
      }`}
    >
      <td className="py-2.5 pl-[22px] pr-3 align-middle" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${lampName(lamp)} seç`}
          checked={checked}
          onChange={onToggle}
          className={checkbox}
        />
      </td>
      <td colSpan={nameSpan} className="px-3 py-2.5 align-middle">
        <span className="flex items-center gap-2 border-l-2 border-border pl-3">
          <BulbIcon className={lampOn(lamp) ? "text-accent" : "text-muted"} />
          <span className="truncate text-text">{lampName(lamp)}</span>
          {technical ? <span className="font-mono text-[11px] text-muted">ch{lamp.channel}</span> : null}
          {lamp.status === "fault" ? (
            <span className="rounded-md bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">arıza</span>
          ) : null}
        </span>
      </td>
      {showLight ? (
        <td
          className={`max-w-[150px] truncate whitespace-nowrap px-3 py-2.5 align-middle font-mono ${light.cls}`}
          title={light.text}
        >
          {light.text}
        </td>
      ) : null}
      {restSpan > 0 ? <td colSpan={restSpan} /> : null}
    </tr>
  );
}
