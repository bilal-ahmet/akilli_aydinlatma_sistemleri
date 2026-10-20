"use client";

import { useMemo, useState } from "react";
import type { DeviceView, Zone } from "@/app/_lib/types";
import {
  countSelection,
  deviceSelState,
  replaceWithin,
  selectionText,
  type Selection,
  type SelState,
  type TargetPlan,
} from "@/app/_lib/selection";
import { effectByNumber } from "@/lib/effects";
import { Modal } from "./Modal";
import { SelectionQuickBar } from "./SelectionQuickBar";
import { EmptyBox } from "./PanelUi";
import { DeviceTable } from "./views/DeviceTable";

/**
 * "Nerede çalışsın?" seçimi — Efektler sayfası ve zamanlama formu ortak
 * kullanır: bölge çipleri (bölgenin tamamı) + "Cihazları tek tek seç"
 * penceresi (bölge detayındaki tabloyla aynı; lambalar da seçilebilir).
 */

const checkbox =
  "h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--acc)] disabled:cursor-not-allowed disabled:opacity-40";

/** Bir cihaz listesinin seçim durumu: hiçbiri / bir kısmı / tamamı (cihazın tamamı). */
export function listState(sel: Selection, list: DeviceView[]): SelState {
  if (list.length === 0) return "none";
  const states = list.map((d) => deviceSelState(sel, d));
  if (states.every((s) => s === "all")) return "all";
  return states.some((s) => s !== "none") ? "some" : "none";
}

/** Bölgedeki seçili cihaz sayısı (kısmen seçili cihaz da sayılır). */
export const pickedIn = (sel: Selection, list: DeviceView[]) =>
  list.filter((d) => deviceSelState(sel, d) !== "none").length;

/** Bölgeye bağlı cihazlar ve bölge → cihazlar eşlemesi. */
export function useZonedDevices(devices: DeviceView[]) {
  return useMemo(() => {
    const zoned = devices.filter((d) => d.zoneSlug !== null);
    const byZone = new Map<string, DeviceView[]>();
    for (const d of zoned) {
      const list = byZone.get(d.zoneSlug!);
      if (list) list.push(d);
      else byZone.set(d.zoneSlug!, [d]);
    }
    return { zoned, devicesOf: (zoneId: string) => byZone.get(zoneId) ?? [] };
  }, [devices]);
}

/** Hedef özeti: "tüm bölgeler", "Park Yolu", "2 bölge, 3 cihaz", "1 lamba". */
export function planText(plan: Pick<TargetPlan, "zones" | "devices" | "lamps">, zones: Zone[], all: boolean): string {
  if (all) return "tüm bölgeler";
  const parts: string[] = [];
  if (plan.zones.length === 1) parts.push(zones.find((z) => z.id === plan.zones[0])?.name ?? "1 bölge");
  else if (plan.zones.length > 1) parts.push(`${plan.zones.length} bölge`);
  if (plan.devices.length) parts.push(`${plan.devices.length} cihaz`);
  if (plan.lamps.length) parts.push(`${plan.lamps.length} lamba`);
  return parts.join(", ");
}

const fxLabel = (n: number) => effectByNumber(n)?.label ?? `#${n}`;

// Seçilebilir alan olduğu anlaşılsın: el imleci + üzerine gelince hafif ton.
const chip = (state: SelState) =>
  `inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-3.5 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${
    state === "all"
      ? "border border-text bg-text font-medium text-bg enabled:hover:bg-text/85"
      : state === "some"
        ? "border border-glow/60 bg-glow/15 font-medium text-text enabled:hover:bg-glow/25"
        : "border border-border bg-panel text-ink-2 enabled:hover:border-glow/50 enabled:hover:bg-glow/10 enabled:hover:text-text"
  }`;

/**
 * "Tüm bölgeler" + bölge çipleri + "Cihazları tek tek seç". Pencere bu
 * bileşenin içinde açılır; `inModal` ise üstteki diyaloğun Escape ile
 * kapanmaması için `onPickerChange` ile haber verilir.
 */
export function TargetChips({
  zones,
  zoned,
  devicesOf,
  selection,
  onChange,
  showFx = false,
  onPickerChange,
  className = "",
}: {
  zones: Zone[];
  zoned: DeviceView[];
  devicesOf: (zoneId: string) => DeviceView[];
  selection: Selection;
  onChange: (next: Selection) => void;
  /** Bölgede çalışan efekti çipte göster (Efektler sayfası). */
  showFx?: boolean;
  onPickerChange?: (open: boolean) => void;
  className?: string;
}) {
  const [pickerOpen, setPickerOpenState] = useState(false);
  const setPickerOpen = (open: boolean) => {
    setPickerOpenState(open);
    onPickerChange?.(open);
  };
  const allState = listState(selection, zoned);

  return (
    <>
      <div className={`flex gap-2 ${className}`}>
        <button
          type="button"
          className={chip(allState)}
          disabled={zoned.length === 0}
          aria-pressed={allState === "all"}
          onClick={() => onChange(allState === "all" ? new Map() : new Map(zoned.map((d) => [d.deviceId, null])))}
        >
          Tüm bölgeler
        </button>
        {zones.map((z) => {
          const zl = devicesOf(z.id);
          const st = listState(selection, zl);
          return (
            <button
              key={z.id}
              type="button"
              className={chip(st)}
              disabled={zl.length === 0}
              aria-pressed={st === "all" ? true : st === "some" ? "mixed" : false}
              title={zl.length === 0 ? "Bu bölgede tanımlı cihaz yok" : undefined}
              onClick={() => onChange(replaceWithin(selection, zl, () => st !== "all"))}
            >
              {z.name}
              <span className={`font-mono text-[11.5px] ${st === "all" ? "opacity-70" : "text-muted"}`}>
                {zl.length === 0 ? "—" : `${pickedIn(selection, zl)}/${zl.length}`}
              </span>
              {showFx && z.isOn && z.activeFx != null ? (
                <span className="text-[11.5px] text-accent">✦ {fxLabel(z.activeFx)}</span>
              ) : null}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={zoned.length === 0}
          className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-glow/50 bg-glow/[.06] px-3.5 text-[13px] font-semibold text-accent transition-colors duration-150 enabled:hover:border-glow enabled:hover:bg-glow/15 disabled:cursor-not-allowed disabled:opacity-45 sm:ml-auto"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
          </svg>
          Cihazları tek tek seç
        </button>
      </div>

      {pickerOpen ? (
        <TargetPicker
          zones={zones}
          devicesByZone={devicesOf}
          selection={selection}
          onChange={onChange}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Hedef seçici penceresi: solda bölgeler, sağda seçili bölgenin cihazları
 * (bölge detayındaki tabloyla aynı; lambalar da seçilebilir).
 */
export function TargetPicker({
  zones,
  devicesByZone,
  selection,
  onChange,
  onClose,
}: {
  zones: Zone[];
  devicesByZone: (zoneId: string) => DeviceView[];
  selection: Selection;
  onChange: (next: Selection) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => zones.find((z) => devicesByZone(z.id).length > 0)?.id ?? zones[0]?.id);
  const zone = zones.find((z) => z.id === active);
  const list = zone ? devicesByZone(zone.id) : [];
  const total = countSelection(selection);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Nerede çalışsın?"
      subtitle="Bölgenin tamamını ya da tek tek cihaz ve lambaları seçin."
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-muted">
            {total.devices + total.lamps > 0 ? `${selectionText(total)} seçili` : "Seçim yok"}
          </span>
          <button type="button" onClick={onClose} className="btn-glow h-10 px-5 text-sm">
            Tamam
          </button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Bölgeler" className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
          {zones.map((z) => {
            const zl = devicesByZone(z.id);
            const st = listState(selection, zl);
            const on = z.id === active;
            return (
              <div
                key={z.id}
                className={`flex shrink-0 items-center gap-2 rounded-[10px] px-2.5 py-2 text-sm transition-colors ${
                  on ? "bg-panel-2 font-semibold text-text" : "text-ink-2 hover:bg-panel-2/60"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={zl.length === 0}
                  aria-label={`${z.name} bölgesinin tamamı`}
                  checked={st === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = st === "some";
                  }}
                  onChange={() => onChange(replaceWithin(selection, zl, () => st !== "all"))}
                  className={checkbox}
                />
                <button
                  type="button"
                  onClick={() => setActive(z.id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 text-left"
                >
                  <span className="truncate">{z.name}</span>
                  <span className="shrink-0 font-mono text-[11.5px] text-muted">
                    {zl.length === 0 ? "—" : `${pickedIn(selection, zl)}/${zl.length}`}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-3">
          {zone && list.length > 0 ? (
            <>
              <SelectionQuickBar devices={list} selection={selection} onChange={onChange} />
              <div className="overflow-hidden rounded-xl border border-border">
                <DeviceTable devices={list} selection={selection} onSelectionChange={onChange} compact />
              </div>
            </>
          ) : (
            <EmptyBox>Bu bölgede tanımlı cihaz yok.</EmptyBox>
          )}
        </div>
      </div>
    </Modal>
  );
}
