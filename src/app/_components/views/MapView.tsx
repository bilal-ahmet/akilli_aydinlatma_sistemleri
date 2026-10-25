"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import type { DeviceView, PoleView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { openAlerts } from "@/app/_lib/alerts";
import { deviceName } from "@/app/_lib/format";
import { formatAgo } from "@/app/_lib/deviceHealth";
import { deviceState, lampOn } from "@/app/_lib/selection";
import {
  POLE_STATE_DOT,
  POLE_STATE_LABELS,
  poleStateResolver,
  type PoleState,
} from "@/app/_lib/poles";
import { effectByNumber } from "@/lib/effects";
import { faultCategoryLabel } from "@/lib/faults";
import { BrightnessSlider } from "../BrightnessSlider";
import { useDialogs } from "../PanelDialogs";
import type { MapPole } from "../PoleMap";

// WebGL: yalnız istemcide yüklenir.
const PoleMap = dynamic(() => import("../PoleMap").then((m) => m.PoleMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Harita yükleniyor…</div>,
});

const STATE_ORDER: PoleState[] = ["fault", "offline", "on", "off", "no_device"];

const SOURCE_LABEL: Record<string, string> = {
  map: "haritadan işaretlendi",
  manual: "elle girildi",
  gps: "sahada GPS ile alındı",
  import: "içe aktarıldı",
};

const coordFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 5, maximumFractionDigits: 5 });

/** Seçili direğin yan paneli: konum, cihaz, lambalar, süren arızalar, hızlı kontrol. */
function PolePanel({
  pole,
  state,
  device,
  now,
  onClose,
  onMoveStart,
  moving,
  onMoveSave,
  onMoveCancel,
  busy,
}: {
  pole: PoleView;
  state: PoleState;
  device: DeviceView | undefined;
  now: number | null;
  onClose: () => void;
  onMoveStart: () => void;
  moving: boolean;
  onMoveSave: () => void;
  onMoveCancel: () => void;
  busy: boolean;
}) {
  const technical = useTechnical();
  const { canWrite, customerSlug } = usePanel();
  const { faults, devices, setTargetsPower, setTargetsBrightness } = useLighting();
  const { openDevice, openPoleForm } = useDialogs();
  const alerts = device ? openAlerts(faults, devices, technical).filter((a) => a.deviceId === device.deviceId) : [];
  const light = device ? deviceState(device) : null;

  return (
    <aside className="flex max-h-full flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-xl">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-base font-semibold text-text">
            Direk {pole.code}
            {pole.name ? <span className="font-normal text-muted"> · {pole.name}</span> : null}
          </p>
          <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
            <span aria-hidden className={`h-2 w-2 rounded-full ${POLE_STATE_DOT[state]}`} />
            {POLE_STATE_LABELS[state]}
            <span className="text-muted">
              ·{" "}
              <Link href={`/c/${customerSlug}/bolgeler/${pole.zoneSlug}`} className="hover:text-accent hover:underline">
                {pole.zoneName}
              </Link>
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Paneli kapat"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lg text-muted hover:bg-panel-2 hover:text-text"
        >
          ×
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
        {moving ? (
          <div className="flex flex-col gap-2 rounded-xl bg-accent-soft px-3.5 py-3 text-[13px] text-text">
            <p>İşareti sürükleyerek direğin yerini düzeltin, sonra kaydedin.</p>
            <div className="flex gap-2">
              <button type="button" onClick={onMoveSave} disabled={busy} className="btn-glow h-8 px-3 text-[13px]">
                {busy ? "Kaydediliyor…" : "Konumu kaydet"}
              </button>
              <button type="button" onClick={onMoveCancel} className="btn-line h-8 px-3 text-[13px]">
                Vazgeç
              </button>
            </div>
          </div>
        ) : null}

        {/* Cihaz */}
        <section className="flex flex-col gap-1.5">
          <h3 className="eyebrow">Cihaz</h3>
          {device ? (
            <>
              <button
                type="button"
                onClick={() => openDevice(device)}
                className="self-start text-left text-sm font-semibold text-text hover:text-accent hover:underline"
              >
                {deviceName(device, technical)}
              </button>
              <p className="text-[12.5px] text-muted">
                Son haber: {formatAgo(device.lastSeen, now)}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              Bu direğe cihaz takılı değil.
              {canWrite ? (
                <>
                  {" "}
                  <button type="button" onClick={() => openPoleForm(pole)} className="font-medium text-accent hover:underline">
                    Cihaz bağla
                  </button>
                </>
              ) : null}
            </p>
          )}
        </section>

        {/* Hızlı kontrol */}
        {device && canWrite && light ? (
          <section className="flex flex-col gap-2.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTargetsPower({ devices: [device.deviceId] }, true)}
                className={`btn-line h-9 flex-1 text-[13px] ${light.isOn ? "!border-glow/60 !text-text" : ""}`}
              >
                Aç
              </button>
              <button
                type="button"
                onClick={() => setTargetsPower({ devices: [device.deviceId] }, false)}
                className={`btn-line h-9 flex-1 text-[13px] ${light.isOn === false ? "!border-border-strong !text-text" : ""}`}
              >
                Kapat
              </button>
            </div>
            <BrightnessSlider
              value={light.isOn ? light.brightness : 0}
              onChange={(v) => setTargetsBrightness({ devices: [device.deviceId] }, v)}
              label={`Direk ${pole.code} ışık şiddeti`}
            />
          </section>
        ) : null}

        {/* Lambalar */}
        {device ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="eyebrow">Lambalar · {device.lamps.length}</h3>
            {device.lamps.length === 0 ? (
              <p className="text-[13px] text-muted">Cihaz henüz lamba bildirmedi.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {device.lamps.map((l) => {
                  const fx = effectByNumber(l.activeFx);
                  const faulty = l.status === "fault";
                  return (
                    <li key={l.channel} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
                      <span
                        aria-hidden
                        className={`h-2 w-2 shrink-0 rounded-full ${faulty ? "bg-danger" : lampOn(l) ? "bg-glow" : "bg-muted"}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-text">
                        {l.name?.trim() || `Lamba ${l.channel}`}
                        {technical ? <span className="ml-1 font-mono text-[11px] text-muted">ch{l.channel}</span> : null}
                      </span>
                      <span className={faulty ? "font-medium text-danger" : "text-ink-2"}>
                        {faulty ? "Arıza" : fx ? fx.label : lampOn(l) ? `%${l.brightness}` : "Kapalı"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {/* Süren arızalar */}
        {alerts.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="eyebrow !text-danger">Süren arızalar · {alerts.length}</h3>
            <ul className="flex flex-col gap-1.5">
              {alerts.map((a) => (
                <li key={a.key} className="rounded-xl border border-danger/30 px-3 py-2 text-[13px]">
                  <p className="font-semibold text-text">{a.title}</p>
                  <p className="text-muted">
                    {faultCategoryLabel(a.category, technical)}
                    {a.channel !== null ? ` · Lamba ${a.channel}` : ""}
                    {a.since ? ` · ${formatAgo(a.since, now)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Konum */}
        <section className="flex flex-col gap-1">
          <h3 className="eyebrow">Konum</h3>
          {pole.lat !== null && pole.lng !== null ? (
            <>
              <p className="font-mono text-[12.5px] text-ink-2">
                {coordFmt.format(pole.lat)}, {coordFmt.format(pole.lng)}
              </p>
              <p className="text-[12px] text-muted">
                {pole.locationSource ? SOURCE_LABEL[pole.locationSource] ?? pole.locationSource : ""}
                {pole.locationAccuracyM !== null ? ` · yaklaşık ${Math.round(pole.locationAccuracyM)} m` : ""}
              </p>
            </>
          ) : null}
          {pole.notes ? <p className="mt-1 text-[13px] text-ink-2">{pole.notes}</p> : null}
        </section>
      </div>

      {canWrite && !moving ? (
        <div className="flex gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={() => openPoleForm(pole)} className="btn-line h-9 flex-1 text-[13px]">
            Düzenle
          </button>
          <button type="button" onClick={onMoveStart} className="btn-line h-9 flex-1 text-[13px]">
            Konumu taşı
          </button>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * Harita sayfası: müşterinin konumlu direkleri, bağlı cihazdan türetilen
 * canlı durum rengiyle (SSE ile güncellenir). Direğe tıklayınca yan panel;
 * "Direk ekle" ile haritaya tıklanan noktaya yeni direk; konumu girilmemiş
 * direkler listeden seçilip haritaya yerleştirilir.
 *
 * `initialZone` (?bolge=) haritayı o bölgeye süzer, `initialPole` (?direk=)
 * o direğe yakınlaşıp panelini açar.
 */
export function MapView({ initialZone = "", initialPole = "" }: { initialZone?: string; initialPole?: string }) {
  const { zones, poles, devices, faultsByDevice, polesLoading, updatePole } = useLighting();
  const { canWrite } = usePanel();
  const { openPoleForm, openPoleImport } = useDialogs();
  const now = useNow(15_000);

  const [zoneFilter, setZoneFilter] = useState(initialZone);
  const [hidden, setHidden] = useState<Set<PoleState>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(initialPole || null);
  const [adding, setAdding] = useState(false);
  /** Konumu girilmemiş, haritaya yerleştirilecek direk. */
  const [placing, setPlacing] = useState<PoleView | null>(null);
  const [moving, setMoving] = useState<{ id: string; lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnlocated, setShowUnlocated] = useState(false);

  const stateOf = poleStateResolver(devices, faultsByDevice, now);
  const byMac = new Map(devices.map((d) => [d.deviceId, d]));
  const inZone = poles.filter((p) => !zoneFilter || p.zoneSlug === zoneFilter);
  const located = inZone.filter((p) => p.lat !== null && p.lng !== null);
  const unlocated = inZone.filter((p) => p.lat === null || p.lng === null);

  const counts = new Map<PoleState, number>();
  const mapPoles: MapPole[] = [];
  for (const p of located) {
    const s = stateOf(p);
    counts.set(s, (counts.get(s) ?? 0) + 1);
    if (!hidden.has(s)) mapPoles.push({ id: p.id, code: p.code, lat: p.lat!, lng: p.lng!, state: s });
  }

  const selected = selectedId ? poles.find((p) => p.id === selectedId) : undefined;
  const initialFocus = poles.find((p) => p.id === initialPole && p.lat !== null);
  const pickMode = adding || placing !== null;

  function toggleState(s: PoleState) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  async function handleAddAt(lat: number, lng: number) {
    if (placing) {
      setBusy(true);
      setError(null);
      try {
        await updatePole(placing.id, { lat, lng, locationSource: "map" });
        setSelectedId(placing.id);
        setPlacing(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Konum kaydedilemedi");
      } finally {
        setBusy(false);
      }
      return;
    }
    setAdding(false);
    openPoleForm(undefined, {
      zoneSlug: zoneFilter || undefined,
      location: { lat, lng },
      onSaved: (p) => setSelectedId(p.id),
    });
  }

  async function saveMove() {
    if (!moving) return;
    setBusy(true);
    setError(null);
    try {
      await updatePole(moving.id, { lat: moving.lat, lng: moving.lng, locationSource: "map" });
      setMoving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Konum kaydedilemedi");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-132px)] min-h-[480px] flex-col gap-3 lg:h-[calc(100dvh-56px)]">
      {/* Üst şerit: başlık, bölge, durum filtreleri, ekleme */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <h1 className="text-[22px] font-bold tracking-[-0.02em] text-text">Harita</h1>
        {zones.length > 1 ? (
          <select
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
            aria-label="Bölge"
            className="field !h-9 !w-auto !py-0 !text-[13.5px]"
          >
            <option value="">Tüm bölgeler</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Durum filtresi">
          {STATE_ORDER.map((s) => {
            const n = counts.get(s) ?? 0;
            const off = hidden.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleState(s)}
                aria-pressed={!off}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] transition-colors ${
                  off ? "border-border text-muted opacity-60" : "border-border-strong bg-panel text-text"
                }`}
              >
                <span aria-hidden className={`h-2 w-2 rounded-full ${POLE_STATE_DOT[s]}`} />
                {POLE_STATE_LABELS[s]}
                <span className="tabular-nums text-muted">{n}</span>
              </button>
            );
          })}
        </div>
        {canWrite ? (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => openPoleImport(zoneFilter || undefined)}
              className="btn-line h-9 px-3.5 text-[13px]"
            >
              İçe aktar
            </button>
            <button
              type="button"
              onClick={() => {
                setPlacing(null);
                setAdding((a) => !a);
              }}
              className={`h-9 px-3.5 text-[13px] ${adding ? "btn-line" : "btn-glow"}`}
            >
              {adding ? "Eklemeyi bırak" : "+ Direk ekle"}
            </button>
          </div>
        ) : null}
      </div>

      {pickMode ? (
        <p className="rounded-xl bg-accent-soft px-4 py-2.5 text-[13px] text-text">
          {placing
            ? `Direk ${placing.code} için haritada yerine tıklayın.`
            : "Yeni direğin yerine haritada tıklayın."}{" "}
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setPlacing(null);
            }}
            className="font-medium text-accent hover:underline"
          >
            Vazgeç
          </button>
        </p>
      ) : null}
      {error ? <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] text-danger">{error}</p> : null}

      {unlocated.length > 0 ? (
        <div className="rounded-xl border border-border bg-panel px-4 py-2.5 text-[13px]">
          <button
            type="button"
            onClick={() => setShowUnlocated((v) => !v)}
            className="font-medium text-ink-2 hover:text-text"
            aria-expanded={showUnlocated}
          >
            {showUnlocated ? "▾" : "▸"} Konumu girilmemiş {unlocated.length} direk
          </button>
          {showUnlocated ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unlocated.slice(0, 60).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!canWrite}
                  onClick={() => {
                    setAdding(false);
                    setPlacing(p);
                  }}
                  className={`rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors disabled:cursor-default ${
                    placing?.id === p.id ? "border-glow bg-accent-soft text-text" : "border-border text-ink-2 hover:text-text"
                  }`}
                >
                  {p.code}
                </button>
              ))}
              {unlocated.length > 60 ? (
                <span className="self-center text-muted">ve {unlocated.length - 60} direk daha</span>
              ) : null}
              {canWrite ? (
                <span className="w-full text-[12px] text-muted">Bir direk seçip haritada yerine tıklayın.</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-panel-2">
        <PoleMap
          poles={mapPoles}
          selectedId={selectedId}
          onSelect={(id) => {
            if (moving) return;
            setSelectedId(id);
          }}
          addMode={pickMode && !busy}
          onAddAt={handleAddAt}
          editPole={moving}
          onMove={(id, lat, lng) => setMoving({ id, lat, lng })}
          fitKey={zoneFilter}
          focus={
            initialFocus && initialFocus.lat !== null && initialFocus.lng !== null
              ? { key: initialFocus.id, lat: initialFocus.lat, lng: initialFocus.lng }
              : null
          }
        />

        {!polesLoading && poles.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-4 top-4 mx-auto max-w-md rounded-xl border border-border bg-panel/95 px-4 py-3 text-center text-[13px] text-ink-2 shadow-lg">
            Henüz direk kaydı yok.
            {canWrite ? " “+ Direk ekle” ile haritada direklerin yerine tıklayarak başlayın." : ""}
          </div>
        ) : null}

        {selected ? (
          <div className="absolute inset-x-2 bottom-2 max-h-[62%] sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-3 sm:max-h-none sm:w-[340px]">
            <PolePanel
              key={selected.id}
              pole={selected}
              state={stateOf(selected)}
              device={selected.deviceId ? byMac.get(selected.deviceId) : undefined}
              now={now}
              onClose={() => {
                setSelectedId(null);
                setMoving(null);
              }}
              moving={moving?.id === selected.id}
              onMoveStart={() => {
                if (selected.lat !== null && selected.lng !== null) {
                  setMoving({ id: selected.id, lat: selected.lat, lng: selected.lng });
                } else {
                  setPlacing(selected);
                }
              }}
              onMoveSave={saveMove}
              onMoveCancel={() => setMoving(null)}
              busy={busy}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
