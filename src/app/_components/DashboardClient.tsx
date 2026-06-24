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
import { EffectPicker } from "./EffectPicker";
import { Modal } from "./Modal";
import { ZoneForm, type ZoneFormValues } from "./ZoneForm";

async function sendCommand(zoneId: string, action: Action, value?: number, number?: number) {
  const res = await fetch(`/api/zones/${zoneId}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value, number }),
  });
  if (!res.ok) throw new Error(`Komut başarısız (${res.status})`);
}

/** Toplu komut → Meven:all/cmd (tek publish). */
async function sendAll(action: Action, value?: number, number?: number) {
  const res = await fetch(`/api/command/all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value, number }),
  });
  if (!res.ok) throw new Error(`Toplu komut başarısız (${res.status})`);
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

  const summary = useMemo(() => summarize(zones), [zones]);
  const anyOn = useMemo(() => zones.some((z) => z.isOn), [zones]);

  // ── Canlı durum (SSE) ──────────────────────────────────────
  const onLive = useCallback((e: LiveEvent) => {
    if (!e.zoneSlug) return;
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
    sendCommand(id, on ? "on" : "off").catch(() => setZones(prev));
  }

  function setZoneBrightness(id: string, value: number) {
    setZones((zs) => zs.map((z) => (z.id === id ? { ...z, brightness: value, activeFx: null } : z)));
    const timers = dimTimers.current;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      sendCommand(id, "dim", value).catch(() => {});
      timers.delete(id);
    }, 300));
  }

  function setAll(on: boolean) {
    setZones((zs) => zs.map((z) => ({ ...z, isOn: on, activeFx: null })));
    sendAll(on ? "on" : "off").catch(() => {}); // Meven:all/cmd
  }

  function setAllBrightness(value: number) {
    setMasterBrightness(value);
    setZones((zs) => zs.map((z) => ({ ...z, brightness: value, activeFx: null })));
    const timers = dimTimers.current;
    clearTimeout(timers.get("__all__"));
    timers.set("__all__", setTimeout(() => {
      sendAll("dim", value).catch(() => {});
      timers.delete("__all__");
    }, 300));
  }

  // ── Efektler ───────────────────────────────────────────────
  function pickEffect(number: number) {
    const t = effectTarget;
    if (!t) return;
    if (t === "all") {
      setZones((zs) => zs.map((z) => ({ ...z, isOn: true, activeFx: number })));
      sendAll("efekt", undefined, number).catch(() => {});
    } else {
      setZones((zs) => zs.map((z) => (z.id === t.id ? { ...z, isOn: true, activeFx: number } : z)));
      sendCommand(t.id, "efekt", undefined, number).catch(() => {});
    }
    setEffectTarget(null);
  }

  function stopEffect() {
    const t = effectTarget;
    if (!t) return;
    if (t === "all") {
      setZones((zs) => zs.map((z) => ({ ...z, activeFx: null })));
      sendAll("dim", masterBrightness).catch(() => {});
    } else {
      setZones((zs) => zs.map((z) => (z.id === t.id ? { ...z, activeFx: null } : z)));
      sendCommand(t.id, "dim", t.brightness).catch(() => {});
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
