"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Zone, ZoneStatus } from "@/app/_lib/types";
import { summarize } from "@/app/_lib/mockData";
import type { Action, LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
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
  const [masterBrightness, setMasterBrightness] = useState(() =>
    deriveMaster(initialZones),
  );

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

  function beginPending(target: string) {
    pendingRef.current.set(target, (pendingRef.current.get(target) ?? 0) + 1);
  }
  function endPending(target: string) {
    const n = (pendingRef.current.get(target) ?? 1) - 1;
    if (n <= 0) pendingRef.current.delete(target);
    else pendingRef.current.set(target, n);
  }

  const summary = useMemo(() => summarize(zones), [zones]);
  const anyOn = useMemo(() => zones.some((z) => z.isOn), [zones]);

  // ── Canlı durum (SSE) ──────────────────────────────────────
  const onLive = useCallback((e: LiveEvent) => {
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
        if (typeof e.isOn === "boolean") next.isOn = e.isOn;
        if (typeof e.brightness === "number") next.brightness = e.brightness;
        if (typeof e.activeFx !== "undefined") next.activeFx = e.activeFx;
        if (e.deviceId) next.status = (e.status === "error" ? "fault" : "ok") as ZoneStatus;
        return next;
      }),
    );
  }, []);

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
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, brightness: value, activeFx: null } : z)));
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
    setZones((zs) => zs.map((z) => ({ ...z, isOn: on, activeFx: null })));
    const ids = zones.map((z) => z.id);
    ids.forEach(beginPending);
    sendAll(on ? "on" : "off")
      .then((seq) => ids.forEach((id) => applySeq(id, seq)))
      .catch(() => {})
      .finally(() => ids.forEach(endPending)); // Meven:all/cmd
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value);
    setZones((zs) => zs.map((z) => ({ ...z, brightness: value, activeFx: null })));
    const ids = zones.map((z) => z.id);
    const timers = dimTimers.current;
    clearTimeout(timers.get("__all__"));
    timers.set("__all__", setTimeout(() => {
      ids.forEach(beginPending);
      sendAll("dim", value)
        .then((seq) => ids.forEach((id) => applySeq(id, seq)))
        .catch(() => {})
        .finally(() => ids.forEach(endPending));
      timers.delete("__all__");
    }, DIM_DEBOUNCE_MS));
  }

  // ── Efektler ───────────────────────────────────────────────
  function pickEffect(number: number, text?: string) {
    const t = effectTarget;
    if (!t) return;
    if (t === "all") {
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
        // Düzenleme — durum dahil tüm alanları PATCH'le.
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
      <StatusOverview summary={summary} />
      <MasterControl
        anyOn={anyOn}
        masterBrightness={masterBrightness}
        onSetAll={setAll}
        onSetAllBrightness={setAllBrightness}
        onEffectAll={() => setEffectTarget("all")}
      />
      <ZoneGrid
        zones={zones}
        onToggle={toggleZone}
        onBrightness={setZoneBrightness}
        onCreate={openCreate}
        onEffect={(z) => setEffectTarget(z)}
        onEdit={openEdit}
        onDelete={(z) => setDeleting(z)}
      />
      <DeviceManager zones={zones} />

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
