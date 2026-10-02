"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceView, Fixture, D4iSnapshot, FaultEvent } from "@/app/_lib/types";
import { type Action, type LiveEvent, MAX_CHANNEL } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useApi, usePanel } from "@/app/_lib/panel";
import { effectByNumber } from "@/lib/effects";
import { describeDeviceError } from "@/lib/deviceErrors";
import { formatMac } from "@/lib/mac";
import { deviceName } from "@/app/_lib/format";
import { Modal } from "./Modal";
import { Toggle } from "./Toggle";
import { BrightnessSlider } from "./BrightnessSlider";
import { EffectPicker } from "./EffectPicker";
import { D4iPanel } from "./D4iPanel";
import { FaultHistory } from "./FaultHistory";

/** Slider sürüklenirken publish selini önler; bırakılınca komut bu kadar sonra gider. */
const DIM_DEBOUNCE_MS = 150;

/**
 * Cihazdan rapor gelince D4i panelinin tazelenmesi bu kadar geciktirilir; aynı
 * anda birden çok kanalın raporu düşerse tek fetch'te birleşir.
 */
const TELEMETRY_REFRESH_MS = 1200;

/** Cihaz bazlı komut → POST /api/devices/:id/command. channel yoksa tüm cihaz. */
type ApiFn = (path: string) => string;

async function sendDeviceCommand(
  api: ApiFn,
  deviceId: string,
  body: { action: Action; value?: number; number?: number; channel?: number; text?: string },
): Promise<number | undefined> {
  const res = await fetch(api(`/api/devices/${deviceId}/command`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
  const json = await res.json().catch(() => null);
  return json?.data?.seq;
}

/** Kanal başına son D4i raporu → GET /api/devices/:id/telemetry. */
function fetchTelemetry(api: ApiFn, deviceId: string): Promise<D4iSnapshot[]> {
  return fetch(api(`/api/devices/${deviceId}/telemetry`))
    .then((r) => r.json())
    .then((j) => (j.data ?? []) as D4iSnapshot[]);
}

/** Arıza geçmişi (süren + çözülen) → GET /api/devices/:id/faults. */
function fetchFaults(api: ApiFn, deviceId: string): Promise<FaultEvent[]> {
  return fetch(api(`/api/devices/${deviceId}/faults`))
    .then((r) => r.json())
    .then((j) => (j.data ?? []) as FaultEvent[]);
}

type Tab = "control" | "telemetry" | "faults";

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
  initialOn,
  initialBrightness,
  onClose,
}: {
  device: DeviceView;
  /**
   * "Tüm cihaz" kontrolünün açılıştaki seed değeri — cihazın BÖLGESİNİN komut
   * snapshot'ından gelir (zones.isOn/brightness). Böylece son bölge/"Tüm Sistem"
   * komutunu yansıtır; telemetriden (device_status) değil (üstten-alta model).
   */
  initialOn: boolean;
  initialBrightness: number;
  onClose: () => void;
}) {
  const deviceId = device.deviceId;
  const api = useApi();
  const { canWrite, technical } = usePanel();
  // Admin "Kanal 3 / ch3" görür, müşteri "Lamba 3" (DALI adresi terimi yok).
  const lampRef = (ch: number) => (technical ? `Kanal ${ch}` : `Lamba ${ch}`);

  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading] = useState(true);

  // D4i telemetrisi (kanal başına son rapor) — açılışta, cihazdan her yeni
  // rapor geldiğinde (SSE) ve "Yenile" ile çekilir.
  const [telemetry, setTelemetry] = useState<D4iSnapshot[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(true);
  const [telemetryAt, setTelemetryAt] = useState<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Arıza geçmişi (fault_events) — telemetri ile aynı ritimde tazelenir.
  const [faults, setFaults] = useState<FaultEvent[]>([]);
  const [faultsLoading, setFaultsLoading] = useState(true);

  const [tab, setTab] = useState<Tab>("control");

  // Cihazın son komut yanıtı hatası; SSE'den gelen ack ile canlı güncellenir.
  const [lastError, setLastError] = useState<string | null>(device.lastError);

  // "Tüm cihaz" BAĞIMSIZ bir kontroldür — lambaların ortalamasından TÜRETİLMEZ.
  // Tek bir lambayı değiştirmek "Tüm cihaz"ı oynatmaz (alttan üste etki yok).
  // Değeri yalnızca ÜSTTEN ALTA veya kendi seviyesinde değişir:
  //   - yerel "Tüm cihaz" toggle/dim (optimistic)
  //   - cihaz-seviyesi komut echo'su (başka client, aynı seviye)
  //   - bölge / "Tüm Sistem" komutu (top-down) — bkz. onLive
  // Bölge komut snapshot'ından tek seferlik seed edilir (bkz. initialOn/…).
  const [deviceOn, setDeviceOn] = useState(initialOn);
  const [deviceBrightness, setDeviceBrightness] = useState(initialBrightness);
  const zoneSlug = device.zoneSlug;

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
    fetch(api(`/api/devices/${deviceId}/fixtures`))
      .then((r) => r.json())
      .then((j) => setFixtures((j.data ?? []) as Fixture[]))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [api, deviceId]);

  /**
   * Telemetriyi arka planda tazeler — "Yükleniyor…" göstergesini KENDİSİ
   * açmaz (canlı yenilemede butonun sürekli titrememesi için); manuel
   * "Yenile" butonu bunu ayrıca `setTelemetryLoading(true)` ile yapar.
   */
  const loadTelemetry = useCallback(() => {
    fetchTelemetry(api, deviceId)
      .then((rows) => {
        setTelemetry(rows);
        setTelemetryAt(Date.now());
      })
      .catch(() => {})
      .finally(() => setTelemetryLoading(false));
  }, [api, deviceId]);

  /** Arıza geçmişi — arıza satırı yalnızca durum değişiminde yazılır. */
  const loadFaults = useCallback(() => {
    fetchFaults(api, deviceId)
      .then(setFaults)
      .catch(() => {})
      .finally(() => setFaultsLoading(false));
  }, [api, deviceId]);

  useEffect(() => {
    loadTelemetry();
    loadFaults();
  }, [loadTelemetry, loadFaults]);

  /**
   * Cihazdan yeni rapor geldiğinde telemetriyi ve arıza geçmişini tazeler.
   * Cihaz her DALI adresi için ayrı mesaj yayınladığından (bkz. handleD4i) art
   * arda gelen kanal raporları tek fetch'te birleşsin diye kısa bir pencere
   * beklenir. Aktif sekmeden bağımsız çalışır: sekme değiştirildiğinde veri
   * hazır olsun ve arıza rozeti canlı kalsın.
   */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return; // tazeleme zaten planlı
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadTelemetry();
      loadFaults();
    }, TELEMETRY_REFRESH_MS);
  }, [loadTelemetry, loadFaults]);

  useEffect(() => {
    const timer = refreshTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // ── Canlı durum (SSE): bu cihaza ait event'leri rafine et ──
  const onLive = useCallback(
    (e: LiveEvent) => {
      // ── ÜSTTEN ALTA: "Tüm Sistem" (scope:"all") veya bu cihazın bölgesine
      // giden komut, "Tüm cihaz" kontrolünü günceller. deviceId filtresinden
      // ÖNCE ele alınır (bu olaylar deviceId taşımaz). Yerel "Tüm cihaz" komutu
      // uçuştaysa atlanır ki optimistic değer bozulmasın.
      const topDown =
        e.kind === "command" &&
        (e.scope === "all" || (!!zoneSlug && e.zoneSlug === zoneSlug));
      if (topDown) {
        if ((pendingRef.current.get("__device__") ?? 0) === 0) {
          if (typeof e.isOn === "boolean") setDeviceOn(e.isOn);
          if (typeof e.brightness === "number") setDeviceBrightness(e.brightness);
        }
        return;
      }

      if (e.deviceId !== deviceId) return;
      // Komut yanıtı: durum taşımaz, yalnızca hata bandını günceller. Aşağıdaki
      // in-flight guard'ından ÖNCE ele alınmalı — ack tam da komut uçuştayken gelir.
      if (e.kind === "ack") {
        setLastError(e.error ?? null);
        scheduleRefresh(); // komut hatası da arıza geçmişine yazılır
        return;
      }
      // Cihazın periyodik raporu: paneller DB'den okuduğu için event'in kendisi
      // arıza ayrıntısını taşımaz — tazele. Aşağıdaki in-flight guard'ı
      // yalnızca optimistic UI state'i içindir, tazelemeyi kapsamaz.
      if (e.kind === "telemetry") scheduleRefresh();
      const seqKey = typeof e.channel === "number" ? `ch-${e.channel}` : "__device__";
      if ((pendingRef.current.get(seqKey) ?? 0) > 0) return; // yanıtı beklenen daha yeni bir komut var
      if (typeof e.seq === "number") {
        const lastSeq = lastSeqRef.current.get(seqKey);
        if (lastSeq !== undefined && e.seq < lastSeq) return; // eski komut-echo, yok say
        lastSeqRef.current.set(seqKey, e.seq);
      }
      if (typeof e.channel === "number") {
        // Lamba (leaf) — "Tüm cihaz"a ALTTAN ÜSTE bubble ETMEZ, yalnızca
        // ilgili fixture satırını günceller.
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
      } else if (e.kind === "command") {
        // Cihaz-seviyesi komut echo'su (aynı seviye — örn. başka client "Tüm
        // cihaz"ı değiştirdi). Telemetri (kind:"telemetry") device-level
        // olayları "Tüm cihaz"ı DEĞİŞTİRMEZ (alttan üste etki yok).
        if (typeof e.isOn === "boolean") setDeviceOn(e.isOn);
        if (typeof e.brightness === "number") setDeviceBrightness(e.brightness);
      }
    },
    [deviceId, zoneSlug, scheduleRefresh],
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
    sendDeviceCommand(api, deviceId, { action: on ? "on" : "off" })
      .then((seq) => applySeq("__device__", seq))
      .catch(() => {})
      .finally(() => endPending("__device__"));
  }

  function setDeviceDim(value: number) {
    setDeviceBrightness(value);
    setFixtures((fs) => fs.map((f) => ({ ...f, brightness: value, isOn: true, activeFx: null })));
    debounce("__device__", () => sendDeviceCommand(api, deviceId, { action: "dim", value }));
  }

  // ── Tüm hattı süren efektin durdurulması ──────────────────
  // Chase gibi efektler cihazın TÜM lambalarında birlikte başlar (kanal
  // kabul etmezler), bu yüzden bir lambada yapılan her işlem (durdur, aç/kapa,
  // şiddet, başka efekt) önce efekti cihazın tamamında durdurur — yoksa yalnızca
  // o lamba durur, diğerleri efekte devam ederdi.
  //
  // Durdurma kanalsız bir `dim` komutudur ("Tüm cihaz" durdurmasıyla aynı).
  // Ardından gelen lamba komutu bu isteğin yanıtını bekler: iki POST paralel
  // gitseydi sunucuya ters sırada ulaşıp lamba komutunu ezebilirdi.
  const fxStopRef = useRef<Promise<unknown>>(Promise.resolve());

  function runsGroupEffect(ch: number): boolean {
    return !!effectByNumber(fixtures.find((f) => f.channel === ch)?.activeFx)?.allLamps;
  }

  /** Cihazın tamamında efekti durdur; lambalar "Tüm cihaz" şiddetine döner. */
  function stopDeviceEffect() {
    const value = deviceBrightness;
    setDeviceOn(true);
    // Sunucunun `dim` yaması (patchFor) ile aynı: tüm lambalar açık, aynı şiddet.
    setFixtures((fs) => fs.map((f) => ({ ...f, isOn: true, brightness: value, activeFx: null })));
    beginPending("__device__");
    fxStopRef.current = sendDeviceCommand(api, deviceId, { action: "dim", value })
      .then((seq) => applySeq("__device__", seq))
      .catch(() => {})
      .finally(() => endPending("__device__"));
  }

  /** Lamba komutundan önce: lamba tüm hattı süren bir efektteyse önce onu durdur. */
  function stopGroupEffectFor(ch: number) {
    if (runsGroupEffect(ch)) stopDeviceEffect();
  }

  /** Tek lamba komutu — varsa uçuştaki efekt durdurmasının ardından gider. */
  function sendFixtureCommand(body: Parameters<typeof sendDeviceCommand>[2]) {
    return fxStopRef.current.then(() => sendDeviceCommand(api, deviceId, body));
  }

  // ── Tek lamba (kanal) ─────────────────────────────────────
  function toggleFixture(ch: number, on: boolean) {
    stopGroupEffectFor(ch);
    setFixtures((fs) => fs.map((f) => (f.channel === ch ? { ...f, isOn: on, activeFx: null } : f)));
    const key = `ch-${ch}`;
    beginPending(key);
    sendFixtureCommand({ action: on ? "on" : "off", channel: ch })
      .then((seq) => applySeq(key, seq))
      .catch(() => {})
      .finally(() => endPending(key));
  }

  function setFixtureDim(ch: number, value: number) {
    stopGroupEffectFor(ch);
    setFixtures((fs) =>
      fs.map((f) => (f.channel === ch ? { ...f, brightness: value, isOn: true, activeFx: null } : f)),
    );
    debounce(`ch-${ch}`, () => sendFixtureCommand({ action: "dim", value, channel: ch }));
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
      sendDeviceCommand(api, deviceId, { action: "efekt", number, text })
        .then((seq) => applySeq("__device__", seq))
        .catch(() => {})
        .finally(() => endPending("__device__"));
    } else {
      stopGroupEffectFor(t);
      setFixtures((fs) => fs.map((f) => (f.channel === t ? { ...f, isOn: true, activeFx: number } : f)));
      const key = `ch-${t}`;
      beginPending(key);
      sendFixtureCommand({ action: "efekt", number, channel: t, text })
        .then((seq) => applySeq(key, seq))
        .catch(() => {})
        .finally(() => endPending(key));
    }
    setEffectTarget(null);
  }

  function stopEffect() {
    const t = effectTarget;
    if (t === null) return;
    // Tüm hattı süren efekt tek lambadan da durdurulsa cihazın tamamında durur.
    if (t === "device" || runsGroupEffect(t)) {
      stopDeviceEffect();
    } else {
      const f = fixtures.find((x) => x.channel === t);
      setFixtures((fs) => fs.map((x) => (x.channel === t ? { ...x, activeFx: null } : x)));
      const key = `ch-${t}`;
      beginPending(key);
      sendDeviceCommand(api, deviceId, { action: "dim", value: f?.brightness ?? 0, channel: t })
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
      setFormError(
        technical
          ? `Kanal 0-${MAX_CHANNEL} arası bir sayı olmalı`
          : "Geçerli bir Lamba numarası girin",
      );
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const url =
        form.mode === "add"
          ? `/api/devices/${deviceId}/fixtures`
          : `/api/devices/${deviceId}/fixtures/${form.original.channel}`;
      const res = await fetch(api(url), {
        method: form.mode === "add" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          form.mode === "add"
            ? { channel: ch, name: formName.trim() || undefined }
            : { channel: ch, name: formName.trim() },
        ),
      });
      const j = await res.json();
      if (!res.ok) {
        throw new Error(j.error ?? (technical ? `Hata (${res.status})` : "İşlem tamamlanamadı, tekrar deneyin."));
      }
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
    fetch(api(`/api/devices/${deviceId}/fixtures/${ch}`), { method: "DELETE" }).catch(() => {});
  }

  // Telemetri kanal no ile gelir; başlıklarda dashboard'da girilen lamba adını
  // göstermek için kanal → isim eşlemesi.
  const fixtureNames = useMemo(
    () => new Map(fixtures.map((f) => [f.channel, f.name] as const)),
    [fixtures],
  );

  const effectTitle =
    effectTarget === "device"
      ? `${deviceName(device, technical)} — Efektler`
      : effectTarget !== null
        ? `${lampRef(effectTarget)} — Efektler`
        : "Efektler";
  // "Tüm cihaz": bütün lambalarda aynı efekt çalışıyorsa (tüm hattı süren
  // efektler böyle başlar) o efekt etkin gösterilir.
  const deviceFx =
    fixtures.length > 0 && fixtures.every((f) => f.activeFx === fixtures[0].activeFx)
      ? fixtures[0].activeFx
      : null;
  const effectActiveFx =
    effectTarget === "device"
      ? deviceFx
      : effectTarget !== null
        ? (fixtures.find((f) => f.channel === effectTarget)?.activeFx ?? null)
        : null;

  // Süren arıza sayısı — sekme rozetinde, hangi sekmede olursak olalım görünür.
  const ongoingFaults = faults.filter((f) => f.resolvedAt === null).length;

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "control", label: "Kontrol" },
    { id: "telemetry", label: technical ? "Telemetri" : "Ölçümler" },
    { id: "faults", label: "Arıza geçmişi" },
  ];

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={deviceName(device, technical)}
        subtitle={
          <span className="text-xs">
            {technical ? null : "Cihaz kodu "}
            <span className="font-mono">{formatMac(deviceId)}</span>
            {device.zoneName ? ` · ${device.zoneName}` : ""}
          </span>
        }
      >
        {/* Cihazın son komut yanıtı hata ise: başarılı bir yanıt gelene kadar durur */}
        {lastError ? (
          (() => {
            const info = describeDeviceError(lastError, { technical });
            return (
              <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                <p className="font-semibold">{info.title}</p>
                <p className="mt-0.5">{info.cause}</p>
                {info.hint ? <p className="mt-1 text-muted">{info.hint}</p> : null}
              </div>
            );
          })()
        ) : null}

        {/* Sekmeler — içerik uzun; kontrol / telemetri / arıza geçmişi ayrık durur */}
        <div
          role="tablist"
          aria-label="Cihaz panelleri"
          className="mb-4 flex gap-1 rounded-xl border border-border bg-panel-2 p-1"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-glow/20 text-text"
                  : "text-muted hover:text-text"
              }`}
            >
              {t.label}
              {t.id === "faults" && ongoingFaults > 0 ? (
                <span className="rounded-md bg-danger/20 px-1.5 py-0.5 text-xs font-semibold text-danger">
                  {ongoingFaults}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "telemetry" ? (
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
        ) : tab === "faults" ? (
          <FaultHistory
            rows={faults}
            names={fixtureNames}
            loading={faultsLoading}
            onRefresh={() => {
              setFaultsLoading(true);
              loadFaults();
            }}
          />
        ) : (
          // Salt okunur hesapta kontrol sekmesindeki tüm düğmeler pasif
          // (fieldset disabled); sunucu da yazma isteklerine 403 döner.
          <fieldset disabled={!canWrite} className="m-0 min-w-0 border-0 p-0">
        {/* Cihaz-seviyesi kontrol (tüm lambalar) */}
        <div className="rounded-xl border border-border bg-panel-2 p-3.5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-base font-semibold text-text">
              {technical ? "Tüm cihaz" : "Tüm lambalar"}
            </span>
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
          {/* Kapalıyken bar 0; açılınca son seviyeye döner (değer state'te korunur). */}
          <BrightnessSlider
            value={deviceOn ? deviceBrightness : 0}
            onChange={setDeviceDim}
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
              {technical
                ? "Bu cihazda tanımlı lamba yok. “Lamba ekle” ile kanal tanımla; cihaz çok-lamba verisi yayınladığında lambalar otomatik da eklenir."
                : "Bu cihazın lambaları, cihaz çalışmaya başlayınca burada görünür. İsterseniz “Lamba ekle” ile kendiniz de ekleyebilirsiniz."}
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
                      {technical ? (
                        <span className="shrink-0 font-mono text-xs text-muted">ch{f.channel}</span>
                      ) : null}
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
                        aria-label={`${lampRef(f.channel)} efekti`}
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
                        aria-label={`${lampRef(f.channel)} düzenle`}
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
                        aria-label={`${lampRef(f.channel)} sil`}
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
                        label={`${lampRef(f.channel)} aç/kapat`}
                      />
                    </div>
                  </div>
                  <BrightnessSlider
                    value={f.isOn ? f.brightness : 0}
                    onChange={(v) => setFixtureDim(f.channel, v)}
                    label={`${lampRef(f.channel)} parlaklığı`}
                  />
                </div>
              );
            })
          )}
        </div>

          </fieldset>
        )}
      </Modal>

      {/* Lamba ekle / düzenle */}
      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.mode === "edit" ? "Lambayı düzenle" : "Lamba ekle"}
        subtitle={
          form?.mode === "edit" ? (
            <span className="text-xs">
              {form.original.name || `Lamba ${form.original.channel}`}
              {technical ? <span className="font-mono"> · ch{form.original.channel}</span> : null}
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
              {technical ? "Kanal (DALI adresi) *" : "Lamba numarası"}
            </label>
            <input
              id="fx-ch"
              type="number"
              min={0}
              max={MAX_CHANNEL}
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              value={formChannel}
              onChange={(e) => setFormChannel(e.target.value)}
              placeholder={technical ? `0 - ${MAX_CHANNEL}` : "Örn. 3"}
            />
            {/* Kanal = cihazın DALI adresi; değiştirmek komutu başka lambaya yollar. */}
            {form?.mode === "edit" && formChannel !== String(form.original.channel) ? (
              <p className="mt-1.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                {technical ? (
                  <>
                    Kanal cihazın DALI adresidir; değiştirirsen komutlar artık{" "}
                    <span className="font-mono">ch{formChannel || "?"}</span> adresindeki lambaya
                    gider. Eski adresin D4i geçmişi ch{form.original.channel} altında kalır ve cihaz
                    o adresi raporlamayı sürdürürse lamba listede yeniden belirir.
                  </>
                ) : (
                  <>Numarayı yalnızca yanlış girildiyse değiştirin.</>
                )}
              </p>
            ) : null}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="fx-name">
              İsim (isteğe bağlı)
            </label>
            <input
              id="fx-name"
              className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Örn. Sol kol"
            />
            {technical ? (
              <p className="mt-1 text-xs text-muted">
                Lamba listesinde ve D4i telemetrisinde bu isim görünür. Boş bırakılırsa{" "}
                <span className="font-mono">Lamba {formChannel || "<kanal>"}</span> yazılır.
              </p>
            ) : null}
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
