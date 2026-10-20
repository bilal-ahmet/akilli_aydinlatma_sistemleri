"use client";

import type { DeviceView } from "@/app/_lib/types";
import {
  countSelection,
  deviceState,
  replaceWithin,
  selectionText,
  type Selection,
} from "@/app/_lib/selection";

/**
 * Tablonun üstündeki hızlı seçimler: Tümü / Açık olanlar / Kapalı olanlar /
 * Temizle. Yalnızca `devices` (bölge ya da seçicideki liste) içinde çalışır;
 * listenin dışındaki seçim korunur.
 */
export function SelectionQuickBar({
  devices,
  selection,
  onChange,
}: {
  devices: DeviceView[];
  selection: Selection;
  onChange: (next: Selection) => void;
}) {
  const inList = new Map(
    [...selection].filter(([mac]) => devices.some((d) => d.deviceId === mac)),
  );
  const count = countSelection(inList);
  const chip =
    "inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full border border-border bg-panel px-3 text-[13px] text-ink-2 transition-colors duration-150 enabled:hover:border-glow/50 enabled:hover:bg-glow/10 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50";

  const onCount = devices.filter((d) => deviceState(d).isOn === true).length;
  const offCount = devices.filter((d) => deviceState(d).isOn === false).length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[13px] text-muted">Seç:</span>
      <button type="button" className={chip} onClick={() => onChange(replaceWithin(selection, devices, () => true))}>
        Tümü <span className="ml-1 opacity-60">{devices.length}</span>
      </button>
      <button
        type="button"
        className={chip}
        disabled={onCount === 0}
        onClick={() => onChange(replaceWithin(selection, devices, (d) => deviceState(d).isOn === true))}
      >
        Açık olanlar <span className="ml-1 opacity-60">{onCount}</span>
      </button>
      <button
        type="button"
        className={chip}
        disabled={offCount === 0}
        onClick={() => onChange(replaceWithin(selection, devices, (d) => deviceState(d).isOn === false))}
      >
        Kapalı olanlar <span className="ml-1 opacity-60">{offCount}</span>
      </button>
      <button
        type="button"
        className={chip}
        disabled={inList.size === 0}
        onClick={() => onChange(replaceWithin(selection, devices, () => false))}
      >
        Temizle
      </button>
      {inList.size > 0 ? (
        <span className="ml-auto text-[13px] font-medium text-text">{selectionText(count)} seçili</span>
      ) : null}
    </div>
  );
}
