"use client";

import { useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { EFFECTS, MORSE_TEXT_MAX, normalizeMorseText, type Effect } from "@/lib/effects";
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
            <span className="mr-1.5 font-mono text-[11px] font-normal text-muted">{fx.number}</span>
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
              <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2">metin</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * Efektler: katalogdan efekt seç, hangi bölgelerde çalışacağını belirle.
 * Tüm bölgeler seçiliyse tek "Tüm Sistem" isteği gider (sunucu bölge
 * topic'lerine fanout eder); değilse her seçili bölgeye ayrı bölge komutu.
 * Tek lambaya efekt cihaz panelinden verilir.
 */
export function EffectsView() {
  const { zones, applyEffect, stopEffect } = useLighting();
  const { canWrite } = usePanel();
  const [selected, setSelected] = useState<Effect>(EFFECTS[0]);
  // null = tüm bölgeler (varsayılan); yeni eklenen bölge de otomatik dahil olur.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const chosen = zones.filter((z) => picked === null || picked.has(z.id));
  const allChosen = chosen.length === zones.length;
  const target = allChosen ? "all" : chosen.map((z) => z.id);
  const runningCount = (n: number) => zones.filter((z) => z.isOn && z.activeFx === n).length;
  const withEffect = chosen.filter((z) => z.activeFx != null);

  function toggleZone(id: string) {
    setSent(null);
    setPicked((prev) => {
      const next = new Set(prev ?? zones.map((z) => z.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function start() {
    if (chosen.length === 0) return;
    // Boş metin gönderilmez → cihaz son ayarlanan metni tekrar çalar.
    applyEffect(target, selected.number, selected.needsText ? text || undefined : undefined);
    setSent(`${selected.label} ${allChosen ? "tüm bölgelerde" : `${chosen.length} bölgede`} başlatıldı.`);
  }

  // Yalnızca efekt çalışan bölgelere, her biri kendi son şiddetine döner
  // ("Tüm Sistem" durdurması hepsini genel şiddete çekerdi).
  function stop() {
    stopEffect(withEffect.map((z) => z.id));
    setSent("Efekt durduruldu; bölgeler son şiddetine döndü.");
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
      <PageHeader title="Efektler" subtitle="Bir efekt seçin, hangi bölgelerde çalışacağını belirleyin." />

      {zones.length === 0 ? (
        <EmptyBox>Efekt çalıştırmak için önce bir bölge oluşturun.</EmptyBox>
      ) : (
        <div className="grid grid-cols-1 items-start gap-[22px] xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="order-2 flex flex-col gap-6 xl:order-1">
            {section("Tek lamba", "her lamba kendi başına çalar", SINGLE_LAMP_FX)}
            {section("Tüm lambalar", "hattın tamamını birlikte sürer", ALL_LAMP_FX)}
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
                    Cihazda en az {selected.minLamps} lamba ister; lambası yetmeyen cihaz komutu
                    reddeder ve hata bildirimi düşer.
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
                  <p className="text-[13.5px] font-medium text-text">Bölgeler</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(allChosen ? new Set() : null);
                      setSent(null);
                    }}
                    className="text-[12.5px] font-medium text-accent hover:underline"
                  >
                    {allChosen ? "Hiçbiri" : "Tümü"}
                  </button>
                </div>
                <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                  {zones.map((z) => {
                    const on = picked === null || picked.has(z.id);
                    return (
                      <label key={z.id} className="flex cursor-pointer items-center gap-2.5 py-0.5 text-sm text-text">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleZone(z.id)}
                          className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--acc)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{z.name}</span>
                        {z.activeFx != null && z.isOn ? (
                          <span className="shrink-0 text-[11.5px] text-muted">
                            {EFFECTS.find((e) => e.number === z.activeFx)?.label ?? `#${z.activeFx}`}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={start}
                  disabled={chosen.length === 0}
                  className="btn-glow h-11 text-[14.5px]"
                >
                  {chosen.length === 0
                    ? "Bölge seçin"
                    : allChosen
                      ? "Tüm bölgelerde başlat"
                      : `${chosen.length} bölgede başlat`}
                </button>
                {withEffect.length > 0 ? (
                  <button type="button" onClick={stop} className="btn-line h-10 text-sm">
                    Efekti durdur ({withEffect.length} bölge)
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
