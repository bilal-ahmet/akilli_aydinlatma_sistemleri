"use client";

import { useState } from "react";
import type { DeviceView, ScheduleView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useApi } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { isEmptyPlan, planTargets, pruneSelection, type Selection } from "@/app/_lib/selection";
import { EFFECTS, MORSE_TEXT_MAX, effectByNumber, normalizeMorseText } from "@/lib/effects";
import { sunEventUtc } from "@/lib/sun";
import {
  EVERY_DAY,
  WEEKDAYS_ONLY,
  WEEKDAY_LABELS,
  WEEKEND_ONLY,
  formatClock,
  formatRunAt,
  localDateString,
  localParts,
  nextRunAt,
  type ScheduleAction,
  type ScheduleRepeat,
  type ScheduleTarget,
  type ScheduleTimeKind,
} from "@/lib/scheduleTime";
import { BrightnessSlider } from "./BrightnessSlider";
import { Modal } from "./Modal";
import { TargetChips, listState, planText, useZonedDevices } from "./TargetSelect";

/** Kısayollardan (seçim çubuğu, Efektler) formu doldurmak için. */
export interface SchedulePrefill {
  action?: ScheduleAction;
  value?: number | null;
  effectNumber?: number | null;
  effectText?: string | null;
  selection?: Selection | "all";
}

export function ClockIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const ACTION_OPTIONS: { value: ScheduleAction; label: string }[] = [
  { value: "on", label: "Aç" },
  { value: "off", label: "Kapat" },
  { value: "dim", label: "Şiddet" },
  { value: "efekt", label: "Efekt" },
  { value: "stop_fx", label: "Efekti durdur" },
];

const OFFSETS = [-120, -90, -60, -45, -30, -20, -15, -10, -5, 0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const offsetLabel = (o: number) => (o === 0 ? "Tam zamanında" : `${Math.abs(o)} dk ${o < 0 ? "önce" : "sonra"}`);

const SINGLE_LAMP_FX = EFFECTS.filter((fx) => !fx.allLamps);
const ALL_LAMP_FX = EFFECTS.filter((fx) => fx.allLamps);

/** Kayıtlı hedeften seçim: bölge → bölgenin bütün cihazları, lamba → kanal kümesi. */
function selectionFromTarget(target: ScheduleTarget, devices: DeviceView[]): Selection | "all" {
  if ("all" in target) return "all";
  const sel: Selection = new Map();
  const zones = new Set(target.zones);
  for (const d of devices) if (d.zoneSlug && zones.has(d.zoneSlug)) sel.set(d.deviceId, null);
  for (const mac of target.devices) sel.set(mac, null);
  for (const { mac, channel } of target.lamps) {
    const cur = sel.get(mac);
    if (cur === null) continue;
    sel.set(mac, new Set([...(cur ?? []), channel]));
  }
  return sel;
}

const parseClock = (s: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Zamanlama formu: Ne yapılsın · Nerede · Ne zaman · Ad. Hedef Efektler
 * sayfasıyla aynı seçimle verilir ve `planTargets` ile kaydedilir: bütün
 * cihazları seçili bölge bölge olarak saklanır (sonradan eklenen cihaz da
 * dahil olur), her şey seçiliyse "Tüm bölgeler".
 */
export function ScheduleDialog({
  schedule,
  prefill,
  onClose,
  onSaved,
}: {
  schedule?: ScheduleView;
  prefill?: SchedulePrefill;
  onClose: () => void;
  onSaved?: (s: ScheduleView) => void;
}) {
  const api = useApi();
  const { zones, devices } = useLighting();
  const { zoned, devicesOf } = useZonedDevices(devices);
  const now = useNow(30_000);

  const [action, setAction] = useState<ScheduleAction>(schedule?.action ?? prefill?.action ?? "on");
  const initialValue = schedule?.value ?? prefill?.value ?? null;
  const [withLevel, setWithLevel] = useState(action === "on" && initialValue != null);
  const [value, setValue] = useState(initialValue ?? 100);
  const [effectNumber, setEffectNumber] = useState(schedule?.effectNumber ?? prefill?.effectNumber ?? EFFECTS[0].number);
  const [effectText, setEffectText] = useState(schedule?.effectText ?? prefill?.effectText ?? "");
  const [picked, setPicked] = useState<Selection | "all">(() =>
    schedule ? selectionFromTarget(schedule.target, devices) : (prefill?.selection ?? "all"),
  );
  const [repeat, setRepeat] = useState<ScheduleRepeat>(schedule?.repeat ?? "weekly");
  const [weekdays, setWeekdays] = useState(schedule?.weekdays ?? EVERY_DAY);
  const [runDateState, setRunDate] = useState<string | null>(schedule?.runDate ?? null);
  const [timeKind, setTimeKind] = useState<ScheduleTimeKind>(schedule?.timeKind ?? "fixed");
  const [clock, setClock] = useState(formatClock(schedule?.timeMinutes ?? 18 * 60 + 30));
  const [offset, setOffset] = useState(schedule?.offsetMinutes ?? 0);
  const [name, setName] = useState(schedule?.name ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tarih alanının varsayılanı bugündür; "şimdi" mount'tan sonra bilinir.
  const today = now === null ? "" : localDateString(new Date(now));
  const runDate = runDateState ?? today;

  const selection: Selection =
    picked === "all" ? new Map(zoned.map((d) => [d.deviceId, null])) : pruneSelection(picked, zoned);
  const fx = action === "efekt" ? effectByNumber(effectNumber) : undefined;
  const plan = planTargets(selection, zoned, zones, fx);
  const allChosen = zoned.length > 0 && listState(selection, zoned) === "all" && plan.skipped.length === 0;
  const emptyTarget = !allChosen && isEmptyPlan(plan);
  const target: ScheduleTarget = allChosen
    ? { all: true }
    : { zones: plan.zones, devices: plan.devices, lamps: plan.lamps };

  const timeMinutes = parseClock(clock);
  const spec = {
    repeat,
    runDate: repeat === "once" ? runDate : null,
    weekdays: repeat === "weekly" ? weekdays : null,
    timeKind,
    timeMinutes: timeKind === "fixed" ? timeMinutes : null,
    offsetMinutes: timeKind === "fixed" ? 0 : offset,
  };
  const next = now === null ? null : nextRunAt(spec, new Date(now));
  const todayParts = now === null ? null : localParts(new Date(now));
  const sunToday =
    todayParts && timeKind !== "fixed"
      ? sunEventUtc(todayParts.y, todayParts.m, todayParts.d, timeKind)
      : null;

  const timeInvalid =
    (timeKind === "fixed" && timeMinutes == null) ||
    (repeat === "weekly" && weekdays === 0) ||
    (repeat === "once" && !runDate);
  const canSubmit = !submitting && !emptyTarget && !timeInvalid && next !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const body = {
      name: name.trim() || null,
      action,
      value: action === "dim" ? value : action === "on" && withLevel ? value : null,
      effectNumber: action === "efekt" ? effectNumber : null,
      effectText: action === "efekt" && fx?.needsText && effectText ? effectText : null,
      target,
      ...spec,
    };
    try {
      const res = await fetch(api(schedule ? `/api/schedules/${schedule.id}` : "/api/schedules"), {
        method: schedule ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Kaydedilemedi (${res.status})`);
      onSaved?.(j.data as ScheduleView);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
      setSubmitting(false);
    }
  }

  const seg = (on: boolean) =>
    `inline-flex h-9 cursor-pointer items-center rounded-[9px] px-3.5 text-[13.5px] transition-colors ${
      on ? "bg-panel font-semibold text-text shadow-[0_1px_3px_rgba(0,0,0,.12)]" : "text-ink-2 hover:text-text"
    }`;
  const dayChip = (on: boolean) =>
    `inline-flex h-9 min-w-11 cursor-pointer items-center justify-center rounded-full border px-2.5 text-[13px] transition-colors ${
      on
        ? "border-text bg-text font-medium text-bg hover:bg-text/85"
        : "border-border bg-panel text-ink-2 hover:border-glow/50 hover:bg-glow/10 hover:text-text"
    }`;
  const preset = "cursor-pointer text-[12.5px] font-medium text-accent hover:underline";
  const heading = "mb-2.5 text-[13.5px] font-semibold text-text";

  return (
    <Modal
      open
      // Hedef penceresi açıkken Escape yalnızca onu kapatsın.
      onClose={pickerOpen ? () => {} : onClose}
      size="lg"
      title={schedule ? "Zamanlamayı düzenle" : "Yeni zamanlama"}
      subtitle="Seçtiğiniz saatte lambalar kendiliğinden açılır, kapanır ya da efekt başlar."
      onSubmit={handleSubmit}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-muted">
            {next ? (
              <>
                Sonraki çalışma: <span className="font-medium text-text">{formatRunAt(next, new Date(now!))}</span>
              </>
            ) : now !== null && !timeInvalid ? (
              <span className="text-danger">Seçilen zaman geçmişte kaldı</span>
            ) : null}
          </span>
          <button type="button" onClick={onClose} className="btn-line h-10 cursor-pointer px-[18px] text-sm">
            İptal
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-glow h-10 cursor-pointer px-5 text-sm">
            {submitting ? "Kaydediliyor…" : schedule ? "Kaydet" : "Zamanla"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        {/* 1. Ne yapılsın */}
        <section>
          <h3 className={heading}>Ne yapılsın?</h3>
          <div role="radiogroup" aria-label="İşlem" className="inline-flex flex-wrap gap-1 rounded-xl bg-panel-2 p-1">
            {ACTION_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={action === o.value}
                onClick={() => setAction(o.value)}
                className={seg(action === o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>

          {action === "on" ? (
            <div className="mt-3 flex flex-col gap-2.5">
              <label className="inline-flex cursor-pointer items-center gap-2 text-[13.5px] text-ink-2">
                <input
                  type="checkbox"
                  checked={withLevel}
                  onChange={(e) => setWithLevel(e.target.checked)}
                  className="h-[18px] w-[18px] cursor-pointer accent-[var(--acc)]"
                />
                Belirli bir şiddette aç
              </label>
              {withLevel ? <BrightnessSlider value={value} onChange={setValue} label="Açılış şiddeti" /> : null}
            </div>
          ) : null}

          {action === "dim" ? (
            <div className="mt-3">
              <BrightnessSlider value={value} onChange={setValue} label="Işık şiddeti" />
              {value === 0 ? <p className="mt-1.5 text-[12.5px] text-muted">%0 lambaları kapatır.</p> : null}
            </div>
          ) : null}

          {action === "efekt" ? (
            <div className="mt-3 flex flex-col gap-2.5">
              <select
                value={effectNumber}
                onChange={(e) => setEffectNumber(Number(e.target.value))}
                aria-label="Efekt"
                className="field cursor-pointer"
              >
                <optgroup label="Tek lamba · her lamba kendi başına çalar">
                  {SINGLE_LAMP_FX.map((f) => (
                    <option key={f.number} value={f.number}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Tüm lambalar · cihazdaki lambalar birlikte çalar">
                  {ALL_LAMP_FX.map((f) => (
                    <option key={f.number} value={f.number}>
                      {f.label}
                      {f.minLamps ? ` (en az ${f.minLamps} lamba)` : ""}
                    </option>
                  ))}
                </optgroup>
              </select>
              {fx ? <p className="text-[12.5px] leading-snug text-muted">{fx.desc}</p> : null}
              {fx?.needsText ? (
                <label className="flex items-center gap-2">
                  <span className="text-[13px] text-ink-2">Metin</span>
                  <input
                    value={effectText}
                    maxLength={MORSE_TEXT_MAX}
                    onChange={(e) => setEffectText(normalizeMorseText(e.target.value))}
                    placeholder="MERHABA"
                    title="Boş bırakırsanız cihaz son metni tekrar çalar."
                    className="field !h-10 !w-48 font-mono tracking-wider"
                  />
                  <span className="font-mono text-[11.5px] text-muted">
                    {effectText.length}/{MORSE_TEXT_MAX}
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {action === "stop_fx" ? (
            <p className="mt-2.5 text-[12.5px] leading-snug text-muted">
              Çalışan efekt durur, lambalar son şiddetine döner. Efekt çalışmayan lambalara dokunulmaz.
            </p>
          ) : null}
        </section>

        {/* 2. Nerede */}
        <section>
          <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold text-text">Nerede?</h3>
            <span className="text-[13px] text-muted">
              {emptyTarget
                ? plan.skipped.length
                  ? `Seçili cihazların lambası bu efekt için yetmiyor (en az ${fx?.minLamps}).`
                  : "Seçim yok"
                : planText(plan, zones, allChosen)}
            </span>
          </div>
          {zones.length === 0 ? (
            <p className="text-[13px] text-muted">Önce bir bölge oluşturun.</p>
          ) : (
            <TargetChips
              zones={zones}
              zoned={zoned}
              devicesOf={devicesOf}
              selection={selection}
              onChange={setPicked}
              onPickerChange={setPickerOpen}
              className="flex-wrap"
            />
          )}
          {!emptyTarget && plan.skipped.length > 0 ? (
            <p className="mt-2 text-[12.5px] text-warn">
              {plan.skipped.length} cihaz atlanacak: bu efekt en az {fx?.minLamps} lamba ister.
            </p>
          ) : null}
        </section>

        {/* 3. Ne zaman */}
        <section className="flex flex-col gap-3.5">
          <h3 className="text-[13.5px] font-semibold text-text">Ne zaman?</h3>
          <div role="radiogroup" aria-label="Tekrar" className="inline-flex w-fit gap-1 rounded-xl bg-panel-2 p-1">
            <button type="button" role="radio" aria-checked={repeat === "weekly"} onClick={() => setRepeat("weekly")} className={seg(repeat === "weekly")}>
              Her hafta
            </button>
            <button type="button" role="radio" aria-checked={repeat === "once"} onClick={() => setRepeat("once")} className={seg(repeat === "once")}>
              Bir kez
            </button>
          </div>

          {repeat === "weekly" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((label, i) => {
                  const bit = 1 << i;
                  const on = (weekdays & bit) !== 0;
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setWeekdays(weekdays ^ bit)}
                      className={dayChip(on)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-3">
                <button type="button" className={preset} onClick={() => setWeekdays(EVERY_DAY)}>
                  Her gün
                </button>
                <button type="button" className={preset} onClick={() => setWeekdays(WEEKDAYS_ONLY)}>
                  Hafta içi
                </button>
                <button type="button" className={preset} onClick={() => setWeekdays(WEEKEND_ONLY)}>
                  Hafta sonu
                </button>
              </div>
              {weekdays === 0 ? <p className="text-[12.5px] text-danger">En az bir gün seçin.</p> : null}
            </div>
          ) : (
            <label className="flex flex-col">
              <span className="field-label">Tarih</span>
              <input
                type="date"
                value={runDate}
                min={today || undefined}
                onChange={(e) => setRunDate(e.target.value)}
                className="field !w-52 cursor-pointer"
              />
            </label>
          )}

          <div className="flex flex-col gap-2">
            <span className="field-label !mb-0">Saat</span>
            <div role="radiogroup" aria-label="Saat türü" className="inline-flex w-fit flex-wrap gap-1 rounded-xl bg-panel-2 p-1">
              <button type="button" role="radio" aria-checked={timeKind === "fixed"} onClick={() => setTimeKind("fixed")} className={seg(timeKind === "fixed")}>
                Belirli saatte
              </button>
              <button type="button" role="radio" aria-checked={timeKind === "sunset"} onClick={() => setTimeKind("sunset")} className={seg(timeKind === "sunset")}>
                Gün batımında
              </button>
              <button type="button" role="radio" aria-checked={timeKind === "sunrise"} onClick={() => setTimeKind("sunrise")} className={seg(timeKind === "sunrise")}>
                Gün doğumunda
              </button>
            </div>
            {timeKind === "fixed" ? (
              <input
                type="time"
                value={clock}
                onChange={(e) => setClock(e.target.value)}
                aria-label="Saat"
                className="field !w-36 cursor-pointer font-mono"
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={offset}
                  onChange={(e) => setOffset(Number(e.target.value))}
                  aria-label="Fark"
                  className="field !w-48 cursor-pointer"
                >
                  {OFFSETS.map((o) => (
                    <option key={o} value={o}>
                      {offsetLabel(o)}
                    </option>
                  ))}
                </select>
                {sunToday ? (
                  <span className="text-[12.5px] text-muted">
                    Bugün {timeKind === "sunset" ? "gün batımı" : "gün doğumu"}{" "}
                    {formatClock(localParts(sunToday).minutes)} (Kocaeli). Saat her gün kendiliğinden
                    ayarlanır.
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </section>

        {/* 4. Ad */}
        <section>
          <label className="field-label" htmlFor="schedule-name">
            Ad <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <input
            id="schedule-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Akşam açılışı"
            className="field"
          />
        </section>
      </div>
    </Modal>
  );
}
