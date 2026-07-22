"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceView, Fixture, D4iSnapshot } from "@/app/_lib/types";
import { type Action, type LiveEvent, MAX_CHANNEL } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { effectByNumber } from "@/lib/effects";
import { describeDeviceError } from "@/lib/deviceErrors";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";
import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";
import { EffectPicker } from "./EffectPicker";
import { D4iPanel } from "./D4iPanel";

/** Slider sürüklenirken publish selini önler; bırakılınca komut bu kadar sonra gider. */
const DIM_DEBOUNCE_MS = 150;

/**
 * Cihazdan rapor gelince D4i panelinin tazelenmesi bu kadar geciktirilir; aynı
 * anda birden çok kanalın raporu düşerse tek fetch'te birleşir.
 */
const TELEMETRY_REFRESH_MS = 1200;

/** Cihaz bazlı komut → POST /api/devices/:id/command. channel yoksa tüm cihaz. */
async function sendDeviceCommand(
  deviceId: string,
  body: { action: Action; value?: number; number?: number; channel?: number; text?: string },
): Promise<number | undefined> {
  const res = await fetch(`/api/devices/${deviceId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
  const json = await res.json().catch(() => null);
  return json?.data?.seq;
}

/** Kanal başına son D4i raporu → GET /api/devices/:id/telemetry. */
function fetchTelemetry(deviceId: string): Promise<D4iSnapshot[]> {
  return fetch(`/api/devices/${deviceId}/telemetry`)
    .then((r) => r.json())
    .then((j) => (j.data ?? []) as D4iSnapshot[]);
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

  // D4i telemetrisi (kanal başına son rapor) — açılışta, cihazdan her yeni
  // rapor geldiğinde (SSE) ve "Yenile" ile çekilir.
  const [telemetry, setTelemetry] = useState<D4iSnapshot[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(true);
  const [telemetryAt, setTelemetryAt] = useState<number | null>(null);
  const telemetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cihazın son komut yanıtı hatası; SSE'den gelen ack ile canlı güncellenir.
  const [lastError, setLastError] = useState<string | null>(device.lastError);

  // Cihaz-seviyesi optimistic durum — son telemetriden başlar.
  const [deviceOn, setDeviceOn] = useState(device.relayStatus === "on");
  const [deviceBrightness, setDeviceBrightness] = useState(device.brightness ?? 0);

  // Efekt hedefi: "device" (tüm ESP) veya kanal no
  const [effectTarget, setEffectTarget] = useState<"device" | number | null>(null);

  // Lamba ekleme/düzenleme formu — aynı diyalog iki modda kullanılır.
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; original: Fixture } | null>(
    null,
  );
  const [formChannel, setFormChannel] = useState("");
  const [formName, setFormName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dimTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Son bilinen komut seq'i ("__device__" ya da "ch-<no>" bazlı) — SSE
  // echo'sundan ve bu client'ın kendi komutunun POST cevabından güncellenir;
  // sırası bozulmuş eski echo'ları eler (bkz. lib/mqtt.ts recordCommand).
  const lastSeqRef = useRef<Map<string, number>>(new Map());

  // Bir hedef (cihaz/kanal) için yanıtı henüz dönmemiş (in-flight) komut
  // sayısı. Bu > 0 iken gelen HİÇBİR SSE echo'su uygulanmaz: kullanıcı zaten
  // daha yeni bir komut gönderdi ama o komutun seq'i henüz bilinmiyor,
  // dolayısıyla seq karşılaştırması tek başına yetersiz kalır.
  const pendingRef = useRef<Map<string, number>>(new Map());

  function applySeq(key: string, seq: number | undefined) {
    if (typeof seq !== "number") return;
    const cur = lastSeqRef.current.get(key);
    if (cur === undefined || seq > cur) lastSeqRef.current.set(key, seq);
  }

  function beginPending(key: string) {
    pendingRef.current.set(key, (pendingRef.current.get(key) ?? 0) + 1);
  }
  function endPending(key: string) {
    const n = (pendingRef.current.get(key) ?? 1) - 1;
    if (n <= 0) pendingRef.current.delete(key);
    else pendingRef.current.set(key, n);
  }

  useEffect(() => {
    // Bileşen `key={deviceId}` ile remount olur; loading başlangıçta true.
    fetch(`/api/devices/${deviceId}/fixtures`)
      .then((r) => r.json())
      .then((j) => setFixtures(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deviceId]);

  /**
   * Telemetriyi arka planda tazeler — "Yükleniyor…" göstergesini KENDİSİ
   * açmaz (canlı yenilemede butonun sürekli titrememesi için); manuel
   * "Yenile" butonu bunu ayrıca `setTelemetryLoading(true)` ile yapar.
   */
  const loadTelemetry = useCallback(() => {
    fetchTelemetry(deviceId)
      .then((rows) => {
        setTelemetry(rows);
        setTelemetryAt(Date.now());
      })
      .catch(() => {})
      .finally(() => setTelemetryLoading(false));
  }, [deviceId]);

  useEffect(() => {
    loadTelemetry();
  }, [loadTelemetry]);

  /**
   * Cihazdan yeni rapor geldiğinde paneli tazeler. Cihaz her DALI adresi için
   * ayrı mesaj yayınladığından (bkz. handleD4i) art arda gelen kanal raporları
   * tek fetch'te birleşsin diye kısa bir pencere beklenir.
   */
  const scheduleTelemetryRefresh = useCallback(() => {
    if (telemetryTimer.current) return; // tazeleme zaten planlı
    telemetryTimer.current = setTimeout(() => {
      telemetryTimer.current = null;
      loadTelemetry();
    }, TELEMETRY_REFRESH_MS);
  }, [loadTelemetry]);

  useEffect(() => {
    const timer = telemetryTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // ── Canlı durum (SSE): bu cihaza ait event'leri rafine et ──
  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.deviceId !== deviceId) return;
      // Komut yanıtı: durum taşımaz, yalnızca hata bandını günceller. Aşağıdaki
      // in-flight guard'ından ÖNCE ele alınmalı — ack tam da komut uçuştayken gelir.
      if (e.kind === "ack") {
        setLastError(e.error ?? null);
        return;
      }
      // Cihazın periyodik raporu: D4i paneli DB'den okuduğu için event'in
      // kendisi arıza ayrıntısını taşımaz — paneli tazele. Aşağıdaki in-flight
      // guard'ı yalnızca optimistic UI state'i içindir, tazelemeyi kapsamaz.
      if (e.kind === "telemetry") scheduleTelemetryRefresh();
      const seqKey = typeof e.channel === "number" ? `ch-${e.channel}` : "__device__";
      if ((pendingRef.current.get(seqKey) ?? 0) > 0) return; // yanıtı beklenen daha yeni bir komut var
      if (typeof e.seq === "number") {
        const lastSeq = lastSeqRef.current.get(seqKey);
        if (lastSeq !== undefined && e.seq < lastSeq) return; // eski komut-echo, yok say
        lastSeqRef.current.set(seqKey, e.seq);
      }
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
    [deviceId, scheduleTelemetryRefresh],
  );
  useLiveStatus(onLive);

  function debounce(key: string, fn: () => Promise<number | undefined>) {
    const timers = dimTimers.current;
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        beginPending(key);
        fn()
          .then((seq) => applySeq(key, seq))
          .catch(() => {})
          .finally(() => endPending(key));
        timers.delete(key);
      }, DIM_DEBOUNCE_MS),
    );
  }

  // ── Cihaz-seviyesi (tüm lambalar) ─────────────────────────
  function toggleDevice(on: boolean) {
    setDeviceOn(on);
    setFixtures((fs) => fs.map((f) => ({ ...f, isOn: on, activeFx: null })));
    beginPending("__device__");
    sendDeviceCommand(deviceId, { action: on ? "on" : "off" })
      .then((seq) => applySeq("__device__", seq))
      .catch(() => {})
      .finally(() => endPending("__device__"));
  }

  function setDeviceDim(value: number) {
    setDeviceBrightness(value);
    setFixtures((fs) => fs.map((f) => ({ ...f, brightness: value, isOn: true, activeFx: null })));
    debounce("__device__", () => sendDeviceCommand(deviceId, { action: "dim", value }));
  }

  // ── Tek lamba (kanal) ─────────────────────────────────────
  function toggleFixture(ch: number, on: boolean) {
    setFixtures((fs) => fs.map((f) => (f.channel === ch ? { ...f, isOn: on, activeFx: null } : f)));
    const key = `ch-${ch}`;
    beginPending(key);
    sendDeviceCommand(deviceId, { action: on ? "on" : "off", channel: ch })
      .then((seq) => applySeq(key, seq))
      .catch(() => {})
      .finally(() => endPending(key));
  }

  function setFixtureDim(ch: number, value: number) {
    setFixtures((fs) =>
      fs.map((f) => (f.channel === ch ? { ...f, brightness: value, isOn: true, activeFx: null } : f)),
    );
    debounce(`ch-${ch}`, () => sendDeviceCommand(deviceId, { action: "dim", value, channel: ch }));
  }

  // ── Efektler ──────────────────────────────────────────────
  function pickEffect(number: number, text?: string) {
    // Tüm hattı süren efektler (Chase) kanal kabul etmiyor — tek lamba seçilmiş
    // olsa bile komut cihazın tamamına gider, yoksa cihaz reddederdi
    // ("chase efekti tum lambalari surer, channel gondermeyin").
    const t = effectByNumber(number)?.allLamps ? "device" : effectTarget;
    if (t === null) return;
    if (t === "device") {
      setDeviceOn(true);
      setFixtures((fs) => fs.map((f) => ({ ...f, isOn: true, activeFx: number })));
      beginPending("__device__");
      sendDeviceCommand(deviceId, { action: "efekt", number, text })
        .then((seq) => applySeq("__device__", seq))
        .catch(() => {})
        .finally(() => endPending("__device__"));
    } else {
      setFixtures((fs) => fs.map((f) => (f.channel === t ? { ...f, isOn: true, activeFx: number } : f)));
      const key = `ch-${t}`;
      beginPending(key);
      sendDeviceCommand(deviceId, { action: "efekt", number, channel: t, text })
        .then((seq) => applySeq(key, seq))
        .catch(() => {})
        .finally(() => endPending(key));
    }
    setEffectTarget(null);
  }

  function stopEffect() {
    const t = effectTarget;
    if (t === null) return;
    if (t === "device") {
      setFixtures((fs) => fs.map((f) => ({ ...f, activeFx: null })));
      beginPending("__device__");
      sendDeviceCommand(deviceId, { action: "dim", value: deviceBrightness })
        .then((seq) => applySeq("__device__", seq))
        .catch(() => {})
        .finally(() => endPending("__device__"));
    } else {
      const f = fixtures.find((x) => x.channel === t);
      setFixtures((fs) => fs.map((x) => (x.channel === t ? { ...x, activeFx: null } : x)));
      const key = `ch-${t}`;
      beginPending(key);
      sendDeviceCommand(deviceId, { action: "dim", value: f?.brightness ?? 0, channel: t })
        .then((seq) => applySeq(key, seq))
        .catch(() => {})
        .finally(() => endPending(key));
    }
    setEffectTarget(null);
  }

  // ── Lamba ekle / düzenle / sil ────────────────────────────
  function openAddForm() {
    setForm({ mode: "add" });
    setFormChannel("");
    setFormName("");
    setFormError(null);
  }

  function openEditForm(f: Fixture) {
    setForm({ mode: "edit", original: f });
    setFormChannel(String(f.channel));
    setFormName(f.name ?? "");
    setFormError(null);
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const ch = Number(formChannel);
    if (!Number.isInteger(ch) || ch < 0 || ch > MAX_CHANNEL) {
      setFormError(`Kanal 0-${MAX_CHANNEL} arası bir sayı olmalı`);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const url =
        form.mode === "add"
          ? `/api/devices/${deviceId}/fixtures`
          : `/api/devices/${deviceId}/fixtures/${form.original.channel}`;
      const res = await fetch(url, {
        method: form.mode === "add" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          form.mode === "add"
            ? { channel: ch, name: formName.trim() || undefined }
            : { channel: ch, name: formName.trim() },
        ),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Hata (${res.status})`);
      const saved = j.data as Fixture;
      setFixtures((fs) =>
        (form.mode === "add"
          ? [...fs, saved]
          : fs.map((f) => (f.channel === form.original.channel ? saved : f))
        ).sort((a, b) => a.channel - b.channel),
      );
      setForm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setSubmitting(false);
    }
  }

  function deleteFixture(ch: number) {
    setFixtures((fs) => fs.filter((f) => f.channel !== ch));
    fetch(`/api/devices/${deviceId}/fixtures/${ch}`, { method: "DELETE" }).catch(() => {});
  }

  // Telemetri kanal no ile gelir; başlıklarda dashboard'da girilen lamba adını
  // göstermek için kanal → isim eşlemesi.
  const fixtureNames = useMemo(
    () => new Map(fixtures.map((f) => [f.channel, f.name] as const)),
    [fixtures],
  );

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
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={device.name || formatMac(deviceId)}
        subtitle={
          <span className="font-mono text-xs">
            {formatMac(deviceId)}
            {device.zoneName ? ` · ${device.zoneName}` : ""}
          </span>
        }
      >
        {/* Cihazın son komut yanıtı hata ise: başarılı bir yanıt gelene kadar durur */}
        {lastError ? (
          (() => {
            const info = describeDeviceError(lastError);
            return (
              <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                <p className="font-semibold">{info.title}</p>
                <p className="mt-0.5">{info.cause}</p>
                {info.hint ? <p className="mt-1 text-muted">{info.hint}</p> : null}
              </div>
            );
          })()
        ) : null}

        {/* Cihaz-seviyesi kontrol (tüm lambalar) */}
        <div className="rounded-xl border border-border bg-panel-2 p-3.5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text">Tüm cihaz</span>
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
        <div className="mt-5 mb-2 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-text">
            Lambalar <span className="text-sm font-normal text-muted">({fixtures.length})</span>
          </h3>
          <button
            type="button"
            onClick={openAddForm}
            className="inline-flex items-center gap-1 rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Lamba ekle
          </button>
        </div>

        {/* Kaydırma modal gövdesinde; burada ayrı bir scroll kutusu açılmaz. */}
        <div className="space-y-2">
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
                <div key={f.channel} className="rounded-xl border border-border bg-panel-2 p-3.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-text">
                        {f.name || `Lamba ${f.channel}`}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted">ch{f.channel}</span>
                      {fx ? (
                        <span className="shrink-0 rounded-md bg-glow/20 px-2 py-0.5 text-xs font-semibold text-glow">
                          {fx.label}
                        </span>
                      ) : null}
                      {f.status === "fault" ? (
                        <span className="shrink-0 rounded-md bg-danger/15 px-2 py-0.5 text-xs font-semibold text-danger">
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
                        onClick={() => openEditForm(f)}
                        aria-label={`Kanal ${f.channel} düzenle`}
                        title="Lambayı düzenle"
                        className={iconBtn}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
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

        {/* Sürücü / LED telemetrisi (d4i_periodic raporlarından) */}
        <D4iPanel
          rows={telemetry}
          names={fixtureNames}
          loading={telemetryLoading}
          updatedAt={telemetryAt}
          onRefresh={() => {
            setTelemetryLoading(true);
            loadTelemetry();
          }}
        />
      </Modal>

      {/* Lamba ekle / düzenle */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.mode === "edit" ? "Lambayı düzenle" : "Lamba ekle"}
        subtitle={
          form?.mode === "edit" ? (
            <span className="font-mono text-xs">
              {form.original.name || `Lamba ${form.original.channel}`} · ch{form.original.channel}
            </span>
          ) : undefined
        }
      >
        {formError ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <form onSubmit={submitForm} className="flex flex-col gap-4">
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
              value={formChannel}
              onChange={(e) => setFormChannel(e.target.value)}
              placeholder={`0 - ${MAX_CHANNEL}`}
            />
            {/* Kanal = cihazın DALI adresi; değiştirmek komutu başka lambaya yollar. */}
            {form?.mode === "edit" && formChannel !== String(form.original.channel) ? (
              <p className="mt-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                Kanal cihazın DALI adresidir; değiştirirsen komutlar artık{" "}
                <span className="font-mono">ch{formChannel || "?"}</span> adresindeki lambaya
                gider. Eski adresin D4i geçmişi ch{form.original.channel} altında kalır ve cihaz
                o adresi raporlamayı sürdürürse lamba listede yeniden belirir.
              </p>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="fx-name">
              İsim (opsiyonel)
            </label>
            <input
              id="fx-name"
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Örn. Sol kol"
            />
            <p className="mt-1 text-xs text-muted">
              Lamba listesinde ve D4i telemetrisinde bu isim görünür. Boş bırakılırsa{" "}
              <span className="font-mono">Lamba {formChannel || "<kanal>"}</span> yazılır.
            </p>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
            >
              İptal
            </button>
            <button
              type="submit"
              disabled={submitting || formChannel === ""}
              className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
            >
              {submitting ? "Kaydediliyor…" : form?.mode === "edit" ? "Kaydet" : "Ekle"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Efekt seçici (cihaz ya da tek lamba) */}
      <EffectPicker
        open={effectTarget !== null}
        title={effectTitle}
        activeFx={effectActiveFx}
        lampCount={fixtures.length}
        onClose={() => setEffectTarget(null)}
        onPick={pickEffect}
        onStop={stopEffect}
      />
    </>
  );
}
