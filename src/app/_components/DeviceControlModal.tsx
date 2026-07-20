"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceView, Fixture } from "@/app/_lib/types";
import { type Action, type LiveEvent, MAX_CHANNEL } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { effectByNumber } from "@/lib/effects";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";
import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";
import { EffectPicker } from "./EffectPicker";

/** Slider sürüklenirken publish selini önler; bırakılınca komut bu kadar sonra gider. */
const DIM_DEBOUNCE_MS = 150;

/** Cihaz bazlı komut → POST /api/devices/:id/command. channel yoksa tüm cihaz. */
async function sendDeviceCommand(
  deviceId: string,
  body: { action: Action; value?: number; number?: number; channel?: number },
) {
  const res = await fetch(`/api/devices/${deviceId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
}

const iconBtn =
  "shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-glow/15 hover:text-text";

/**
 * Tek cihazın (ESP) kontrol paneli: hem cihaz-seviyesi (tüm lambalar) hem de
 * her DALI kanalı (lamba) için bağımsız aç/kapa · dim · efekt. Lambalar
 * `GET /api/devices/:id/fixtures` ile yüklenir; canlı durum SSE ile rafine edilir.
 * Parent tarafından `key={deviceId}` ile mount edilir (cihaz değişince taze state).
 */
export function DeviceControlModal({
  device,
  onClose,
}: {
  device: DeviceView;
  onClose: () => void;
}) {
  const deviceId = device.deviceId;

  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);

  // Cihaz-seviyesi optimistic durum — son telemetriden başlar.
  const [deviceOn, setDeviceOn] = useState(device.relayStatus === "on");
  const [deviceBrightness, setDeviceBrightness] = useState(device.brightness ?? 0);

  // Efekt hedefi: "device" (tüm ESP) veya kanal no
  const [effectTarget, setEffectTarget] = useState<"device" | number | null>(null);

  // Lamba ekleme formu
  const [addOpen, setAddOpen] = useState(false);
  const [newChannel, setNewChannel] = useState("");
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dimTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    // Bileşen `key={deviceId}` ile remount olur; loading başlangıçta true.
    fetch(`/api/devices/${deviceId}/fixtures`)
      .then((r) => r.json())
      .then((j) => setFixtures(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deviceId]);

  // ── Canlı durum (SSE): bu cihaza ait event'leri rafine et ──
  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.deviceId !== deviceId) return;
      if (typeof e.channel === "number") {
        setFixtures((prev) =>
          prev.map((f) => {
            if (f.channel !== e.channel) return f;
            const next = { ...f };
            if (typeof e.isOn === "boolean") next.isOn = e.isOn;
            if (typeof e.brightness === "number") next.brightness = e.brightness;
            if (typeof e.activeFx !== "undefined") next.activeFx = e.activeFx;
            next.status = e.status === "error" ? "fault" : "ok";
            return next;
          }),
        );
      } else {
        if (typeof e.isOn === "boolean") setDeviceOn(e.isOn);
        if (typeof e.brightness === "number") setDeviceBrightness(e.brightness);
      }
    },
    [deviceId],
  );
  useLiveStatus(onLive);

  function debounce(key: string, fn: () => Promise<void>) {
    const timers = dimTimers.current;
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        fn().catch(() => {});
        timers.delete(key);
      }, DIM_DEBOUNCE_MS),
    );
  }

  // ── Cihaz-seviyesi (tüm lambalar) ─────────────────────────
  function toggleDevice(on: boolean) {
    setDeviceOn(on);
    setFixtures((fs) => fs.map((f) => ({ ...f, isOn: on, activeFx: null })));
    sendDeviceCommand(deviceId, { action: on ? "on" : "off" }).catch(() => {});
  }

  function setDeviceDim(value: number) {
    setDeviceBrightness(value);
    setFixtures((fs) => fs.map((f) => ({ ...f, brightness: value, isOn: true, activeFx: null })));
    debounce("__device__", () => sendDeviceCommand(deviceId, { action: "dim", value }));
  }

  // ── Tek lamba (kanal) ─────────────────────────────────────
  function toggleFixture(ch: number, on: boolean) {
    setFixtures((fs) => fs.map((f) => (f.channel === ch ? { ...f, isOn: on, activeFx: null } : f)));
    sendDeviceCommand(deviceId, { action: on ? "on" : "off", channel: ch }).catch(() => {});
  }

  function setFixtureDim(ch: number, value: number) {
    setFixtures((fs) =>
      fs.map((f) => (f.channel === ch ? { ...f, brightness: value, isOn: true, activeFx: null } : f)),
    );
    debounce(`ch-${ch}`, () => sendDeviceCommand(deviceId, { action: "dim", value, channel: ch }));
  }

  // ── Efektler ──────────────────────────────────────────────
  function pickEffect(number: number) {
    const t = effectTarget;
    if (t === null) return;
    if (t === "device") {
      setDeviceOn(true);
      setFixtures((fs) => fs.map((f) => ({ ...f, isOn: true, activeFx: number })));
      sendDeviceCommand(deviceId, { action: "efekt", number }).catch(() => {});
    } else {
      setFixtures((fs) => fs.map((f) => (f.channel === t ? { ...f, isOn: true, activeFx: number } : f)));
      sendDeviceCommand(deviceId, { action: "efekt", number, channel: t }).catch(() => {});
    }
    setEffectTarget(null);
  }

  function stopEffect() {
    const t = effectTarget;
    if (t === null) return;
    if (t === "device") {
      setFixtures((fs) => fs.map((f) => ({ ...f, activeFx: null })));
      sendDeviceCommand(deviceId, { action: "dim", value: deviceBrightness }).catch(() => {});
    } else {
      const f = fixtures.find((x) => x.channel === t);
      setFixtures((fs) => fs.map((x) => (x.channel === t ? { ...x, activeFx: null } : x)));
      sendDeviceCommand(deviceId, { action: "dim", value: f?.brightness ?? 0, channel: t }).catch(() => {});
    }
    setEffectTarget(null);
  }

  // ── Lamba ekle / sil ──────────────────────────────────────
  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    const ch = Number(newChannel);
    if (!Number.isInteger(ch) || ch < 0 || ch > MAX_CHANNEL) {
      setAddError(`Kanal 0-${MAX_CHANNEL} arası bir sayı olmalı`);
      return;
    }
    setSubmitting(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/devices/${deviceId}/fixtures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: ch, name: newName.trim() || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Hata (${res.status})`);
      setFixtures((fs) => [...fs, j.data as Fixture].sort((a, b) => a.channel - b.channel));
      setAddOpen(false);
      setNewChannel("");
      setNewName("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setSubmitting(false);
    }
  }

  function deleteFixture(ch: number) {
    setFixtures((fs) => fs.filter((f) => f.channel !== ch));
    fetch(`/api/devices/${deviceId}/fixtures/${ch}`, { method: "DELETE" }).catch(() => {});
  }

  const effectTitle =
    effectTarget === "device"
      ? `${formatMac(deviceId)} — Efektler`
      : effectTarget !== null
        ? `Kanal ${effectTarget} — Efektler`
        : "Efektler";
  const effectActiveFx =
    effectTarget === "device"
      ? null
      : effectTarget !== null
        ? (fixtures.find((f) => f.channel === effectTarget)?.activeFx ?? null)
        : null;

  return (
    <>
      <Modal open onClose={onClose} title={device.name || formatMac(deviceId)}>
        <p className="-mt-2 mb-4 font-mono text-xs text-muted">
          {formatMac(deviceId)}
          {device.zoneName ? ` · ${device.zoneName}` : ""}
        </p>

        {/* Cihaz-seviyesi kontrol (tüm lambalar) */}
        <div className="rounded-xl border border-border bg-panel-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-text">Tüm cihaz</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEffectTarget("device")}
                aria-label="Cihaz efekti"
                title="Efektler"
                className={iconBtn}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
                </svg>
              </button>
              <Toggle checked={deviceOn} onChange={toggleDevice} label="Cihazı aç/kapat" />
            </div>
          </div>
          <BrightnessSlider
            value={deviceBrightness}
            onChange={setDeviceDim}
            disabled={!deviceOn}
            label="Cihaz parlaklığı"
          />
        </div>

        {/* Lambalar (DALI kanalları) */}
        <div className="mt-4 mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">
            Lambalar <span className="text-xs font-normal text-muted">({fixtures.length})</span>
          </h3>
          <button
            type="button"
            onClick={() => {
              setAddError(null);
              setAddOpen(true);
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-glow/40 bg-glow/20 px-2.5 py-1 text-xs font-semibold text-text transition-colors hover:bg-glow/30"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Lamba ekle
          </button>
        </div>

        <div className="max-h-[38vh] space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <p className="py-3 text-sm text-muted">Yükleniyor…</p>
          ) : fixtures.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
              Bu cihazda tanımlı lamba yok. &quot;Lamba ekle&quot; ile kanal tanımla; cihaz
              çok-lamba verisi yayınladığında lambalar otomatik da eklenir.
            </p>
          ) : (
            fixtures.map((f) => {
              const fx = effectByNumber(f.activeFx);
              return (
                <div key={f.channel} className="rounded-xl border border-border bg-panel-2 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 rounded-md bg-panel px-1.5 py-0.5 font-mono text-[11px] text-muted">
                        ch{f.channel}
                      </span>
                      <span className="truncate text-sm font-medium text-text">
                        {f.name || `Lamba ${f.channel}`}
                      </span>
                      {fx ? (
                        <span className="shrink-0 rounded-md bg-glow/20 px-1.5 py-0.5 text-[10px] font-semibold text-glow">
                          {fx.label}
                        </span>
                      ) : null}
                      {f.status === "fault" ? (
                        <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                          arıza
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEffectTarget(f.channel)}
                        aria-label={`Kanal ${f.channel} efekti`}
                        title="Efektler"
                        className={iconBtn}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteFixture(f.channel)}
                        aria-label={`Kanal ${f.channel} sil`}
                        title="Lambayı sil"
                        className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-danger/15 hover:text-danger"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                      </button>
                      <Toggle
                        checked={f.isOn}
                        onChange={(on) => toggleFixture(f.channel, on)}
                        label={`Kanal ${f.channel} aç/kapat`}
                      />
                    </div>
                  </div>
                  <BrightnessSlider
                    value={f.brightness}
                    onChange={(v) => setFixtureDim(f.channel, v)}
                    disabled={!f.isOn}
                    label={`Kanal ${f.channel} parlaklığı`}
                  />
                </div>
              );
            })
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
          >
            Kapat
          </button>
        </div>
      </Modal>

      {/* Lamba ekle */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Lamba ekle">
        {addError ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {addError}
          </p>
        ) : null}
        <form onSubmit={submitAdd} className="flex flex-col gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="fx-ch">
              Kanal (DALI adresi) *
            </label>
            <input
              id="fx-ch"
              type="number"
              min={0}
              max={MAX_CHANNEL}
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              value={newChannel}
              onChange={(e) => setNewChannel(e.target.value)}
              placeholder={`0 - ${MAX_CHANNEL}`}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="fx-name">
              İsim (opsiyonel)
            </label>
            <input
              id="fx-name"
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Örn. Sol kol"
            />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
            >
              İptal
            </button>
            <button
              type="submit"
              disabled={submitting || newChannel === ""}
              className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
            >
              {submitting ? "Kaydediliyor…" : "Ekle"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Efekt seçici (cihaz ya da tek lamba) */}
      <EffectPicker
        open={effectTarget !== null}
        title={effectTitle}
        activeFx={effectActiveFx}
        onClose={() => setEffectTarget(null)}
        onPick={pickEffect}
        onStop={stopEffect}
      />
    </>
  );
}
