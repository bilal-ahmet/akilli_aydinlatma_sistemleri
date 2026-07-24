"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveSummary, OpenFault, Zone, ZoneStatus } from "@/app/_lib/types";
import { summarize } from "@/app/_lib/mockData";
import type { Action, LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useReconcile } from "@/app/_lib/useReconcile";
import { StatusOverview } from "./StatusOverview";
import { MasterControl } from "./MasterControl";
import { ZoneGrid } from "./ZoneGrid";
import { DeviceManager } from "./DeviceManager";
import { ErrorToasts } from "./ErrorToasts";
import { EffectPicker } from "./EffectPicker";
import { Modal } from "./Modal";
import { ZoneForm, type ZoneFormValues } from "./ZoneForm";

/** Slider sürüklenirken publish selini önler; bırakılınca komut bu kadar sonra gider. */
const DIM_DEBOUNCE_MS = 150;

/** Cihaz raporu gelince ölçüm özetinin tazelenmesi bu kadar geciktirilir. */
const LIVE_REFRESH_MS = 1500;

async function sendCommand(
  zoneId: string,
  action: Action,
  value?: number,
  number?: number,
  text?: string,
): Promise<number | undefined> {
  const res = await fetch(`/api/zones/${zoneId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value, number, text }),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
  const json = await res.json().catch(() => null);
  return json?.data?.seq;
}

/** Toplu komut → Meven:all/cmd (tek publish). */
async function sendAll(
  action: Action,
  value?: number,
  number?: number,
  text?: string,
): Promise<number | undefined> {
  const res = await fetch(`/api/command/all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value, number, text }),
  });
  if (!res.ok) throw new Error(`Toplu komut başarısız (${res.status})`);
  const json = await res.json().catch(() => null);
  return json?.data?.seq;
}

/** Master slider başlangıcı: zone'ların ortalama parlaklığından türetilir. */
function deriveMaster(zones: Zone[]): number {
  if (zones.length === 0) return 50;
  const sum = zones.reduce((a, z) => a + z.brightness, 0);
  return Math.round(sum / zones.length);
}

export function DashboardClient({ initialZones }: { initialZones: Zone[] }) {
  const [zones, setZones] = useState<Zone[]>(initialZones);

  // Cihazlardan ölçülmüş özet — yüklenene kadar null (üst şerit tahmine düşer).
  const [live, setLive] = useState<LiveSummary | null>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // O an süren lamba arızaları (cihaz + bölge bilgisiyle). Bölge kartındaki
  // "hangi cihaz" detayı ve cihaz listesindeki arıza rozeti bundan türer.
  const [faults, setFaults] = useState<OpenFault[]>([]);

  // Master (Tüm Sistem) slider'ı BAĞIMSIZ state'tir — bölge ortalamasından
  // TÜRETİLMEZ. Tek bir bölgenin parlaklığını değiştirmek master'ı oynatmamalı.
  // Cross-client senkron için yalnızca "Tüm Sistem" komutunun SSE'deki
  // scope:"all" olayıyla güncellenir (bkz. onLive).
  const [masterBrightness, setMasterBrightness] = useState(() =>
    deriveMaster(initialZones),
  );
  // Master switch de BAĞIMSIZ — bölgelerden türetilmez ("zones.some(isOn)").
  // Tek bir bölgeyi açıp kapamak master switch'i oynatmamalı; master yalnızca
  // "Tüm Sistem" komutuyla (yerel + scope:"all" echo) değişir.
  const [masterOn, setMasterOn] = useState(() => initialZones.some((z) => z.isOn));
  // scope:"all" olaylarının eski/yeni ayrımı + yerel all-komutu uçuşta guard'ı.
  const masterSeqRef = useRef(0);
  const masterPendingRef = useRef(0);

  // CRUD modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Zone | null>(null);
  const [deleting, setDeleting] = useState<Zone | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Efekt picker hedefi: bir bölge, "all" (tüm sistem) veya kapalı
  const [effectTarget, setEffectTarget] = useState<Zone | "all" | null>(null);

  const dimTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Son bilinen komut seq'i (zone bazlı) — SSE echo'sundan ve bu client'ın
  // kendi komutunun POST cevabından güncellenir; sırası bozulmuş eski
  // echo'ları eler (bkz. lib/mqtt.ts recordCommand).
  const lastSeqRef = useRef<Map<string, number>>(new Map());

  // Bir zone için yanıtı henüz dönmemiş (in-flight) komut sayısı. Bu > 0 iken
  // gelen HİÇBİR SSE echo'su uygulanmaz: kullanıcı zaten daha yeni bir komut
  // gönderdi ama o komutun kendi seq'i henüz bilinmiyor, dolayısıyla seq
  // karşılaştırması tek başına yetersiz — az önce gönderilmiş ama seq'i henüz
  // dönmemiş bir düzenlemenin üzerine, seq'i "eski değil" görünen ama aslında
  // bayat bir echo'nun yazmasını bununla engelliyoruz.
  const pendingRef = useRef<Map<string, number>>(new Map());

  function applySeq(target: string, seq: number | undefined) {
    if (typeof seq !== "number") return;
    const cur = lastSeqRef.current.get(target);
    if (cur === undefined || seq > cur) lastSeqRef.current.set(target, seq);
  }

  // Son komutun gönderilme anı — mutabakat (useReconcile) bunun hemen ardından
  // çalışırsa optimistic durumu bayat DB verisiyle ezebilir: `recordCommand`
  // arka planda (`after()`) yazdığı için publish ile DB arasında kısa bir
  // pencere var (bkz. Kural #10).
  const lastCommandAtRef = useRef(0);

  function beginPending(target: string) {
    lastCommandAtRef.current = Date.now();
    pendingRef.current.set(target, (pendingRef.current.get(target) ?? 0) + 1);
  }
  function endPending(target: string) {
    const n = (pendingRef.current.get(target) ?? 1) - 1;
    if (n <= 0) pendingRef.current.delete(target);
    else pendingRef.current.set(target, n);
  }

  const summary = useMemo(() => summarize(zones), [zones]);

  // Arızaları bölge ve cihaz bazında grupla — kartlara/listeye bu haritalar iner.
  const faultsByZone = useMemo(() => {
    const m = new Map<string, OpenFault[]>();
    for (const f of faults) {
      if (!f.zoneSlug) continue;
      (m.get(f.zoneSlug) ?? m.set(f.zoneSlug, []).get(f.zoneSlug)!).push(f);
    }
    return m;
  }, [faults]);
  const faultsByDevice = useMemo(() => {
    const m = new Map<string, OpenFault[]>();
    for (const f of faults) {
      (m.get(f.deviceId) ?? m.set(f.deviceId, []).get(f.deviceId)!).push(f);
    }
    return m;
  }, [faults]);

  /** Cihazlardan ölçülmüş özet (güç, gerilim, arızalı lamba sayısı). */
  const loadLive = useCallback(() => {
    fetch("/api/summary")
      .then((r) => r.json())
      .then((j) => {
        if (j.data) setLive(j.data as LiveSummary);
      })
      .catch(() => {});
  }, []);

  /** O an süren arızalar (bölge kartı detayı + cihaz rozeti). */
  const loadFaults = useCallback(() => {
    fetch("/api/faults")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setFaults(j.data as OpenFault[]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadLive();
    loadFaults();
  }, [loadLive, loadFaults]);

  /**
   * SSE kaçarsa üst şerit ve bölge kartları bayat kalmasın.
   *
   * Ölçüm özeti HER ZAMAN tazelenir (cihazdan gelen gerçek veri, optimistic
   * durumla çakışmaz). Bölge kartları ise uçuşta komut varken ya da az önce
   * komut gönderildiyse atlanır — yoksa henüz DB'ye yazılmamış optimistic
   * durumun üstüne eski değer biner.
   */
  const reconcile = useCallback(() => {
    loadLive();
    loadFaults();
    if (pendingRef.current.size > 0) return;
    if (Date.now() - lastCommandAtRef.current < 5_000) return;
    fetch("/api/zones")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setZones(j.data as Zone[]);
      })
      .catch(() => {});
  }, [loadLive, loadFaults]);
  useReconcile(reconcile);

  /**
   * Cihaz raporu gelince özeti tazele. Her lamba ayrı mesaj yayınladığından
   * (bkz. handleD4i) art arda gelen raporlar tek fetch'te birleşsin diye kısa
   * bir pencere beklenir.
   */
  const scheduleLiveRefresh = useCallback(() => {
    if (liveTimer.current) return;
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      loadLive();
      loadFaults();
    }, LIVE_REFRESH_MS);
  }, [loadLive, loadFaults]);

  useEffect(() => {
    const timer = liveTimer;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // ── Canlı durum (SSE) ──────────────────────────────────────
  const onLive = useCallback(
    (e: LiveEvent) => {
    // Ölçüm özeti (güç/gerilim/arıza) cihaz raporundan sonra DB'den okunur;
    // olayın kendisi bu değerleri taşımaz. Bölge filtresinden ÖNCE ele alınır.
    if (e.kind === "telemetry" || e.kind === "ack") scheduleLiveRefresh();

    // "Tüm Sistem" kapsam olayı: yalnızca master slider'ı senkronlar (bölge
    // durumları kendi zoneSlug'lı olaylarıyla ayrıca güncellenir). Tek bölge
    // değişimi bu olayı üretmez, dolayısıyla master oynamaz.
    if (e.scope === "all") {
      if (masterPendingRef.current > 0) return; // yerel all-komutu uçuşta
      if (typeof e.seq === "number") {
        if (e.seq < masterSeqRef.current) return; // eski echo
        masterSeqRef.current = e.seq;
      }
      if (typeof e.isOn === "boolean") setMasterOn(e.isOn);
      if (typeof e.brightness === "number") setMasterBrightness(e.brightness);
      return; // scope:"all" olayının zoneSlug'ı yok; aşağısı zaten atlardı
    }

    if (!e.zoneSlug) return;
    if ((pendingRef.current.get(e.zoneSlug) ?? 0) > 0) return; // yanıtı beklenen daha yeni bir komut var
    if (typeof e.seq === "number") {
      const lastSeq = lastSeqRef.current.get(e.zoneSlug);
      if (lastSeq !== undefined && e.seq < lastSeq) return; // eski komut-echo, yok say
      lastSeqRef.current.set(e.zoneSlug, e.seq);
    }
    setZones((prev) =>
      prev.map((z) => {
        if (z.id !== e.zoneSlug) return z;
        const next: Zone = { ...z };
        // Parlaklık/açık-kapalı/efekt YALNIZCA komut olaylarından güncellenir
        // (üstten alta). Cihaz telemetrisi (kind:"telemetry") bölge değerlerini
        // ALTTAN ÜSTE değiştirmez — yalnızca arıza (status) bubble eder.
        if (e.kind === "command") {
          if (typeof e.isOn === "boolean") next.isOn = e.isOn;
          if (typeof e.brightness === "number") next.brightness = e.brightness;
          if (typeof e.activeFx !== "undefined") next.activeFx = e.activeFx;
        }
        if (e.deviceId) next.status = (e.status === "error" ? "fault" : "ok") as ZoneStatus;
        return next;
      }),
    );
    },
    [scheduleLiveRefresh],
  );

  useLiveStatus(onLive);

  // ── Aç/kapa & parlaklık (optimistic + API) ─────────────────
  // on/off/dim efekti durdurur → activeFx optimistic olarak null'lanır.
  function toggleZone(id: string, on: boolean) {
    const prev = zones;
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, isOn: on, activeFx: null } : z)));
    beginPending(id);
    sendCommand(id, on ? "on" : "off")
      .then((seq) => applySeq(id, seq))
      .catch(() => setZones(prev))
      .finally(() => endPending(id));
  }

  function setZoneBrightness(id: string, value: number) {
    // dim = aynı zamanda "aç": kapalı bölgede bar sürüklenince optimistic açılır
    // (backend patchFor("dim") de isOn=true yazar). Yoksa bar 0'da kilitli kalır.
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, brightness: value, isOn: true, activeFx: null } : z)));
    const timers = dimTimers.current;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      beginPending(id);
      sendCommand(id, "dim", value)
        .then((seq) => applySeq(id, seq))
        .catch(() => {})
        .finally(() => endPending(id));
      timers.delete(id);
    }, DIM_DEBOUNCE_MS));
  }

  function setAll(on: boolean) {
    setMasterOn(on);
    setZones((zs) => zs.map((z) => ({ ...z, isOn: on, activeFx: null })));
    const ids = zones.map((z) => z.id);
    ids.forEach(beginPending);
    masterPendingRef.current += 1;
    sendAll(on ? "on" : "off")
      .then((seq) => {
        ids.forEach((id) => applySeq(id, seq));
        if (typeof seq === "number" && seq > masterSeqRef.current) masterSeqRef.current = seq;
      })
      .catch(() => {})
      .finally(() => {
        ids.forEach(endPending);
        masterPendingRef.current -= 1;
      }); // Meven:all/cmd
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value); // optimistic — echo (scope:"all") guard ile korunur
    setMasterOn(true); // dim = aç
    setZones((zs) => zs.map((z) => ({ ...z, brightness: value, isOn: true, activeFx: null })));
    const ids = zones.map((z) => z.id);
    const timers = dimTimers.current;
    clearTimeout(timers.get("__all__"));
    timers.set("__all__", setTimeout(() => {
      ids.forEach(beginPending);
      masterPendingRef.current += 1;
      sendAll("dim", value)
        .then((seq) => {
          ids.forEach((id) => applySeq(id, seq));
          if (typeof seq === "number" && seq > masterSeqRef.current) masterSeqRef.current = seq;
        })
        .catch(() => {})
        .finally(() => {
          ids.forEach(endPending);
          masterPendingRef.current -= 1;
        });
      timers.delete("__all__");
    }, DIM_DEBOUNCE_MS));
  }

  // ── Efektler ───────────────────────────────────────────────
  function pickEffect(number: number, text?: string) {
    const t = effectTarget;
    if (!t) return;
    if (t === "all") {
      setMasterOn(true);
      setZones((zs) => zs.map((z) => ({ ...z, isOn: true, activeFx: number })));
      const ids = zones.map((z) => z.id);
      ids.forEach(beginPending);
      sendAll("efekt", undefined, number, text)
        .then((seq) => ids.forEach((id) => applySeq(id, seq)))
        .catch(() => {})
        .finally(() => ids.forEach(endPending));
    } else {
      setZones((zs) => zs.map((z) => (z.id === t.id ? { ...z, isOn: true, activeFx: number } : z)));
      beginPending(t.id);
      sendCommand(t.id, "efekt", undefined, number, text)
        .then((seq) => applySeq(t.id, seq))
        .catch(() => {})
        .finally(() => endPending(t.id));
    }
    setEffectTarget(null);
  }

  function stopEffect() {
    const t = effectTarget;
    if (!t) return;
    if (t === "all") {
      setMasterOn(true);
      setZones((zs) => zs.map((z) => ({ ...z, activeFx: null })));
      const ids = zones.map((z) => z.id);
      ids.forEach(beginPending);
      sendAll("dim", masterBrightness)
        .then((seq) => ids.forEach((id) => applySeq(id, seq)))
        .catch(() => {})
        .finally(() => ids.forEach(endPending));
    } else {
      setZones((zs) => zs.map((z) => (z.id === t.id ? { ...z, activeFx: null } : z)));
      beginPending(t.id);
      sendCommand(t.id, "dim", t.brightness)
        .then((seq) => applySeq(t.id, seq))
        .catch(() => {})
        .finally(() => endPending(t.id));
    }
    setEffectTarget(null);
  }

  // ── CRUD ───────────────────────────────────────────────────
  function openCreate() {
    setEditing(null);
    setFormError(null);
    setFormOpen(true);
  }
  function openEdit(zone: Zone) {
    setEditing(zone);
    setFormError(null);
    setFormOpen(true);
  }

  async function submitForm(values: ZoneFormValues) {
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        // Düzenleme — form alanlarını (isim, konum, direk) PATCH'le.
        const res = await fetch(`/api/zones/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        if (!res.ok) throw new Error(`Güncelleme başarısız (${res.status})`);
        const { data } = (await res.json()) as { data: Zone };
        setZones((zs) => zs.map((z) => (z.id === data.id ? data : z)));
      } else {
        const res = await fetch(`/api/zones`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        });
        if (!res.ok) throw new Error(`Oluşturma başarısız (${res.status})`);
        const { data } = (await res.json()) as { data: Zone };
        setZones((zs) => [...zs, data]);
      }
      setFormOpen(false);
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setSubmitting(false);
    }
  }

  async function doDelete() {
    if (!deleting) return;
    const target = deleting;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/zones/${target.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setZones((zs) => zs.filter((z) => z.id !== target.id));
      setDeleting(null);
    } catch {
      setFormError("Zone silinemedi");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <StatusOverview summary={summary} live={live} />
      <MasterControl
        anyOn={masterOn}
        masterBrightness={masterBrightness}
        onSetAll={setAll}
        onSetAllBrightness={setAllBrightness}
        onEffectAll={() => setEffectTarget("all")}
      />
      <ZoneGrid
        zones={zones}
        faultsByZone={faultsByZone}
        onToggle={toggleZone}
        onBrightness={setZoneBrightness}
        onCreate={openCreate}
        onEffect={(z) => setEffectTarget(z)}
        onEdit={openEdit}
        onDelete={(z) => setDeleting(z)}
      />
      <DeviceManager zones={zones} faultsByDevice={faultsByDevice} />

      {/* Cihazın reddettiği komutların hata bildirimleri */}
      <ErrorToasts />

      {/* Efekt seçici */}
      <EffectPicker
        open={effectTarget !== null}
        title={
          effectTarget === "all"
            ? "Tüm Sistem — Efektler"
            : effectTarget
              ? `${effectTarget.name} — Efektler`
              : "Efektler"
        }
        activeFx={effectTarget && effectTarget !== "all" ? effectTarget.activeFx : null}
        onClose={() => setEffectTarget(null)}
        onPick={pickEffect}
        onStop={stopEffect}
      />

      {/* Ekle / Düzenle */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? "Bölge Düzenle" : "Yeni Bölge"}
      >
        {formError ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}
        <ZoneForm
          initial={editing ?? undefined}
          submitting={submitting}
          onSubmit={submitForm}
          onCancel={() => setFormOpen(false)}
        />
      </Modal>

      {/* Sil onayı */}
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Bölge sil"
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-text">{deleting?.name}</span> bölgesini
          ve bağlı cihazlarını kalıcı olarak silmek istediğine emin misin?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleting(null)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
          >
            İptal
          </button>
          <button
            type="button"
            onClick={doDelete}
            disabled={submitting}
            className="rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
          >
            {submitting ? "Siliniyor…" : "Sil"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
