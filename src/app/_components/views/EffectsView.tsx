"use client";

import { useMemo, useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { deviceName } from "@/app/_lib/format";
import type { DeviceView, Zone } from "@/app/_lib/types";
import { EFFECTS, MORSE_TEXT_MAX, effectByNumber, normalizeMorseText, type Effect } from "@/lib/effects";
import { EmptyBox, PageHeader } from "../PanelUi";

/**
 * Kart önizlemesi: 8 noktanın parlaklığı — efektin zaman içindeki (tek lamba)
 * ya da hat boyunca (çok lambalı) karakterini kabaca anlatır. Yalnızca görsel;
 * firmware davranışının kaynağı `lib/effects.ts`.
 */
const PREVIEW: Record<number, number[]> = {
  1: [0.1, 0.3, 0.5, 0.7, 0.9, 0.7, 0.5, 0.3],
  2: [1, 1, 0.1, 0.1, 1, 1, 0.1, 0.1],
  3: [1, 0.1, 0.1, 0.1, 1, 0.1, 0.1, 0.1],
  4: [0.6, 0.2, 0.9, 0.4, 0.7, 0.15, 1, 0.35],
  5: [0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1],
  6: [0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3, 0.2],
  7: [1, 0.2, 1, 0.1, 0.1, 0.1, 0.1, 0.1],
  8: [0.7, 0.8, 0.6, 0.85, 0.65, 0.75, 0.9, 0.7],
  9: [1, 1, 1, 0.1, 0.5, 0.5, 0.5, 0.1],
  10: [1, 0.1, 1, 0.1, 1, 0.1, 0.1, 0.1],
  11: [0.2, 0.2, 1, 0.2, 0.2, 0.2, 0.9, 0.2],
  12: [0.05, 0.05, 1, 0.3, 0.05, 0.05, 0.05, 0.8],
  13: [1, 0.3, 0.7, 0.1, 0.9, 0.5, 0.2, 0.8],
  14: [0.1, 0.1, 1, 0.1, 0.1, 0.1, 1, 0.1],
  15: [0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55],
  16: [0.1, 0.2, 0.5, 1, 0.5, 0.2, 0.1, 0.1],
  17: [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.85, 1],
  18: [1, 0.1, 0.1, 1, 0.1, 0.1, 1, 0.1],
  19: [0.2, 0.6, 1, 0.6, 0.2, 0.6, 1, 0.6],
  20: [0.4, 0.5, 0.35, 0.6, 0.7, 0.55, 0.65, 0.8],
  21: [1, 0.1, 0.1, 0.1, 1, 0.1, 1, 1],
  22: [1, 0.1, 1, 1, 1, 0.1, 1, 0.1],
  23: [1, 0.15, 1, 0.15, 1, 0.15, 1, 0.15],
  24: [0.2, 0.45, 0.8, 1, 0.8, 0.45, 0.2, 0.1],
  25: [0.1, 0.1, 0.15, 0.3, 0.55, 1, 0.1, 0.1],
  26: [0.1, 0.1, 0.1, 1, 0.1, 0.1, 0.1, 0.1],
  27: [1, 1, 1, 1, 1, 0.1, 0.1, 0.1],
  28: [0.1, 1, 0.1, 0.1, 0.1, 0.1, 1, 0.1],
};
const FLAT = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8];

const SINGLE_LAMP_FX = EFFECTS.filter((fx) => !fx.allLamps);
const ALL_LAMP_FX = EFFECTS.filter((fx) => fx.allLamps);

function Preview({ number }: { number: number }) {
  return (
    <div aria-hidden className="flex h-16 items-center justify-around rounded-[10px] bg-[#1a1916] px-3">
      {(PREVIEW[number] ?? FLAT).map((o, i) => (
        <span
          key={i}
          className="h-3 w-3 rounded-full bg-[oklch(0.82_0.15_75)] shadow-[0_0_12px_oklch(0.8_0.16_72)]"
          style={{ opacity: o }}
        />
      ))}
    </div>
  );
}

function EffectCard({
  fx,
  selected,
  runningIn,
  onSelect,
}: {
  fx: Effect;
  selected: boolean;
  runningIn: number;
  onSelect: () => void;
}) {
  // Efektin sıra numarası firmware kontratıdır; müşteriye bir şey anlatmaz.
  const technical = useTechnical();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col gap-4 rounded-2xl bg-panel p-5 text-left transition-[border-color,box-shadow] ${
        selected
          ? "border-2 border-glow p-[19px] shadow-[0_8px_24px_oklch(0.77_0.16_68/.18)]"
          : "border border-border hover:border-border-strong"
      }`}
    >
      <Preview number={fx.number} />
      <span className="flex flex-col gap-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-semibold text-text">
            {technical ? (
              <span className="mr-1.5 font-mono text-[11px] font-normal text-muted">{fx.number}</span>
            ) : null}
            {fx.label}
          </span>
          {runningIn > 0 ? (
            <span className="shrink-0 text-xs font-semibold text-accent">Çalışıyor</span>
          ) : null}
        </span>
        <span className="text-[13px] leading-[1.45] text-muted">{fx.desc}</span>
        {fx.minLamps != null || fx.needsText ? (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {fx.minLamps != null ? (
              <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                en az {fx.minLamps} lamba
              </span>
            ) : null}
            {fx.needsText ? (
              <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">yazı girilir</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Hedef seçimi: anahtarı olan bölge seçilidir. `null` → bölgenin tamamı
 * (bölge komutu, tek publish — Kural #3); `Set` → yalnızca o cihazlar (her
 * birine cihaz komutu). Seçimin kendisi `null` ise her şey seçilidir; yeni
 * eklenen bölge de otomatik dahil olur.
 */
type Selection = Map<string, Set<string> | null>;

/** "2 bölge ve 3 cihaz" — `suffix` ile Türkçe bulunma eki ("2 bölge ve 3 cihazda"). */
function placeText(zoneCount: number, deviceCount: number, suffix = true): string {
  const parts: string[] = [];
  if (zoneCount) parts.push(`${zoneCount} bölge`);
  if (deviceCount) parts.push(`${deviceCount} cihaz`);
  return parts.join(" ve ") + (suffix ? (deviceCount ? "da" : "de") : "");
}

const fxLabel = (n: number) => effectByNumber(n)?.label ?? `#${n}`;

const checkbox =
  "h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--acc)] disabled:cursor-not-allowed";

/**
 * Efektler: katalogdan efekt seç, hangi bölgelerde / cihazlarda çalışacağını
 * belirle. Tüm bölgeler tamamen seçiliyse tek "Tüm Sistem" isteği gider
 * (sunucu bölge topic'lerine fanout eder); tamamen seçili bölgeye bölge
 * komutu, bölgenin yalnızca bazı cihazları seçiliyse o cihazlara ayrı cihaz
 * komutu. Tek lambaya efekt cihaz panelinden verilir.
 */
export function EffectsView() {
  const { zones, devices, applyEffect, stopEffect } = useLighting();
  const { canWrite } = usePanel();
  const technical = useTechnical();
  const [selected, setSelected] = useState<Effect>(EFFECTS[0]);
  const [picked, setPicked] = useState<Selection | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const devicesByZone = useMemo(() => {
    const m = new Map<string, DeviceView[]>();
    for (const d of devices) {
      if (!d.zoneSlug) continue;
      const list = m.get(d.zoneSlug);
      if (list) list.push(d);
      else m.set(d.zoneSlug, [d]);
    }
    return m;
  }, [devices]);
  const zoneDevices = (zoneId: string) => devicesByZone.get(zoneId) ?? [];

  // Lambası efektin istediğinden az olan cihaz seçilemez (cihaz reddederdi).
  // Lamba kaydı hiç yoksa sayı bilinmiyor demektir; engellenmez.
  const tooFewLamps = (d: DeviceView) =>
    selected.minLamps != null && d.lampCount > 0 && d.lampCount < selected.minLamps;

  /** Bölgenin seçimi: undefined = seçili değil, null = tamamı, Set = bazı cihazlar. */
  const zoneSel = (zoneId: string): Set<string> | null | undefined =>
    picked === null ? null : picked.get(zoneId);

  const fullZones = zones.filter((z) => zoneSel(z.id) === null);
  const partialDevices = zones.flatMap((z) => {
    const sel = zoneSel(z.id);
    return sel ? zoneDevices(z.id).filter((d) => sel.has(d.deviceId) && !tooFewLamps(d)) : [];
  });
  const allChosen = zones.length > 0 && fullZones.length === zones.length;
  const nothing = fullZones.length === 0 && partialDevices.length === 0;

  // Durdurma: efekt çalışan, tamamen seçili bölgeler bölge komutuyla; cihaz
  // bazında başlatılmış (bölgesi efektte görünmeyen) cihazlar cihaz komutuyla.
  const stopZones = fullZones.filter((z) => z.activeFx != null);
  const stopDevices = [
    ...partialDevices,
    ...fullZones.filter((z) => z.activeFx == null).flatMap((z) => zoneDevices(z.id)),
  ].filter((d) => d.activeFx != null);

  /** Efektin çalıştığı yer sayısı: bölge + (efektte olmayan bölgedeki) cihaz. */
  const runningCount = (n: number) => {
    const zonesOn = zones.filter((z) => z.isOn && z.activeFx === n);
    const inZone = new Set(zonesOn.map((z) => z.id));
    return (
      zonesOn.length +
      devices.filter((d) => d.activeFx === n && !(d.zoneSlug && inZone.has(d.zoneSlug))).length
    );
  };

  function update(fn: (next: Selection) => void) {
    setSent(null);
    setPicked((prev) => {
      const next: Selection = prev ? new Map(prev) : new Map(zones.map((z) => [z.id, null]));
      fn(next);
      return next;
    });
  }

  function toggleZone(z: Zone) {
    update((next) => {
      if (next.has(z.id)) next.delete(z.id);
      else next.set(z.id, null);
    });
  }

  function toggleDevice(z: Zone, mac: string) {
    update((next) => {
      const all = zoneDevices(z.id).map((d) => d.deviceId);
      const cur = next.get(z.id);
      const set = new Set(cur === undefined ? [] : cur === null ? all : cur);
      if (set.has(mac)) set.delete(mac);
      else set.add(mac);
      if (set.size === 0) next.delete(z.id);
      else if (set.size === all.length) next.set(z.id, null);
      else next.set(z.id, set);
    });
  }

  function toggleOpen(zoneId: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      return next;
    });
  }

  function start() {
    if (nothing) return;
    // Boş metin gönderilmez → cihaz son ayarlanan metni tekrar çalar.
    const t = selected.needsText ? text || undefined : undefined;
    applyEffect(
      allChosen
        ? "all"
        : { zones: fullZones.map((z) => z.id), devices: partialDevices.map((d) => d.deviceId) },
      selected.number,
      t,
    );
    const where = allChosen ? "tüm bölgelerde" : placeText(fullZones.length, partialDevices.length);
    setSent(`${selected.label} ${where} başlatıldı.`);
  }

  // Yalnızca efekt çalışan hedeflere, her biri kendi son şiddetine döner
  // ("Tüm Sistem" durdurması hepsini genel şiddete çekerdi).
  function stop() {
    stopEffect({ zones: stopZones.map((z) => z.id), devices: stopDevices.map((d) => d.deviceId) });
    setSent("Efekt durduruldu; lambalar son şiddetine döndü.");
  }

  const section = (heading: string, note: string, list: readonly Effect[]) => (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow">
        {heading} <span className="font-normal normal-case tracking-normal">· {note}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((fx) => (
          <EffectCard
            key={fx.number}
            fx={fx}
            selected={fx.number === selected.number}
            runningIn={runningCount(fx.number)}
            onSelect={() => {
              setSelected(fx);
              setSent(null);
            }}
          />
        ))}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        title="Efektler"
        subtitle="Bir efekt seçin, hangi bölgelerde ya da cihazlarda çalışacağını belirleyin."
      />

      {zones.length === 0 ? (
        <EmptyBox>Efekt çalıştırmak için önce bir bölge oluşturun.</EmptyBox>
      ) : (
        <div className="grid grid-cols-1 items-start gap-[22px] xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="order-2 flex flex-col gap-6 xl:order-1">
            {section("Tek lamba", "her lamba kendi başına çalar", SINGLE_LAMP_FX)}
            {section("Tüm lambalar", "cihazdaki lambalar birlikte çalar", ALL_LAMP_FX)}
          </div>

          <aside className="order-1 xl:sticky xl:top-7 xl:order-2">
            <fieldset
              disabled={!canWrite}
              className="m-0 flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-panel p-[22px]"
            >
              <div className="flex flex-col gap-1">
                <p className="eyebrow">Seçili efekt</p>
                <p className="text-xl font-bold text-text">{selected.label}</p>
                <p className="text-[13px] leading-snug text-muted">{selected.desc}</p>
                {selected.minLamps != null ? (
                  <p className="mt-1 text-[12.5px] leading-snug text-ink-2">
                    Bu efekt en az {selected.minLamps} lambalı cihazlarda çalışır.
                  </p>
                ) : null}
              </div>

              {selected.needsText ? (
                <div>
                  <label className="field-label" htmlFor="fx-text">Çalınacak metin</label>
                  <input
                    id="fx-text"
                    value={text}
                    maxLength={MORSE_TEXT_MAX}
                    onChange={(e) => setText(normalizeMorseText(e.target.value))}
                    placeholder="MERHABA"
                    className="field font-mono tracking-wider"
                  />
                  <p className="mt-1.5 flex justify-between gap-2 text-[11.5px] text-muted">
                    <span>Boş bırakırsanız cihaz son metni tekrar çalar.</span>
                    <span className="shrink-0 font-mono">
                      {text.length}/{MORSE_TEXT_MAX}
                    </span>
                  </p>
                </div>
              ) : null}

              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-[13.5px] font-medium text-text">Bölgeler ve cihazlar</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(allChosen ? new Map() : null);
                      setSent(null);
                    }}
                    className="text-[12.5px] font-medium text-accent hover:underline"
                  >
                    {allChosen ? "Hiçbiri" : "Tümü"}
                  </button>
                </div>
                <div className="scroll-y flex max-h-80 flex-col gap-0.5 overflow-y-auto">
                  {zones.map((z) => {
                    const sel = zoneSel(z.id);
                    const list = zoneDevices(z.id);
                    const isOpen = open.has(z.id);
                    return (
                      <div key={z.id} className="flex flex-col">
                        <div className="flex items-center gap-2.5 py-1 text-sm text-text">
                          <input
                            type="checkbox"
                            aria-label={`${z.name} bölgesinin tamamı`}
                            checked={sel !== undefined}
                            ref={(el) => {
                              if (el) el.indeterminate = sel instanceof Set;
                            }}
                            onChange={() => toggleZone(z)}
                            className={checkbox}
                          />
                          <button
                            type="button"
                            onClick={() => toggleOpen(z.id)}
                            disabled={list.length === 0}
                            aria-expanded={isOpen}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
                          >
                            <span className="min-w-0 flex-1 truncate">{z.name}</span>
                            {z.activeFx != null && z.isOn ? (
                              <span className="shrink-0 text-[11.5px] text-muted">{fxLabel(z.activeFx)}</span>
                            ) : null}
                            <span className="shrink-0 text-[11.5px] text-muted">
                              {sel instanceof Set ? `${sel.size}/${list.length}` : list.length} cihaz
                            </span>
                            {list.length > 0 ? (
                              <span
                                aria-hidden
                                className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
                              >
                                ›
                              </span>
                            ) : null}
                          </button>
                        </div>
                        {isOpen ? (
                          <div className="mb-1 ml-[9px] flex flex-col gap-0.5 border-l border-border pl-4">
                            {list.map((d) => {
                              const short = tooFewLamps(d);
                              const on =
                                !short && (sel === null || (sel instanceof Set && sel.has(d.deviceId)));
                              return (
                                <label
                                  key={d.deviceId}
                                  className={`flex items-center gap-2.5 py-0.5 text-[13px] ${short ? "text-muted" : "cursor-pointer text-text"}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={short}
                                    onChange={() => toggleDevice(z, d.deviceId)}
                                    className={checkbox}
                                  />
                                  <span className="min-w-0 flex-1 truncate">{deviceName(d, technical)}</span>
                                  <span className="shrink-0 text-[11.5px] text-muted">
                                    {short
                                      ? "lamba sayısı yetmez"
                                      : d.activeFx != null
                                        ? fxLabel(d.activeFx)
                                        : d.lampCount > 0
                                          ? `${d.lampCount} lamba`
                                          : null}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11.5px] leading-snug text-muted">
                  Bölgenin yalnızca bazı cihazlarında çalıştırmak için bölge adına tıklayıp cihaz seçin.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <button type="button" onClick={start} disabled={nothing} className="btn-glow h-11 text-[14.5px]">
                  {nothing
                    ? "Bölge ya da cihaz seçin"
                    : allChosen
                      ? "Tüm bölgelerde başlat"
                      : `${placeText(fullZones.length, partialDevices.length)} başlat`}
                </button>
                {stopZones.length + stopDevices.length > 0 ? (
                  <button type="button" onClick={stop} className="btn-line h-10 text-sm">
                    Efekti durdur ({placeText(stopZones.length, stopDevices.length, false)})
                  </button>
                ) : null}
                <p aria-live="polite" className="min-h-[1.25rem] text-center text-[12.5px] text-ok">
                  {sent}
                </p>
              </div>
            </fieldset>
          </aside>
        </div>
      )}
    </div>
  );
}
