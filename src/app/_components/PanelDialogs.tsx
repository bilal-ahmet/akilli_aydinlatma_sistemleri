"use client";

import { createContext, useContext, useState } from "react";
import type { DeviceView, Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";
import { ZoneDialog } from "./ZoneForm";
import { DeviceDialog } from "./DeviceForm";
import { DeviceControlModal } from "./DeviceControlModal";
import { EffectPicker } from "./EffectPicker";

/**
 * Panelin ortak diyalogları. Her sayfa (Genel Bakış, Bölgeler, Cihazlar…)
 * aynı formu/paneli açabilsin diye tek yerde tutulur; aynı anda tek diyalog.
 * Nesneler (bölge, cihaz) kimlikleriyle saklanır ve render'da canlı listeden
 * okunur — açıkken SSE ile gelen değişiklikler diyaloğa yansır.
 */
type Dialog =
  | { kind: "zone-form"; zoneId?: string; onCreated?: (zone: Zone) => void }
  | { kind: "zone-delete"; zoneId: string; onDeleted?: () => void }
  | { kind: "zone-effects"; zoneId: string }
  | { kind: "device-form"; mac?: string; zoneSlug?: string }
  | { kind: "device-delete"; mac: string }
  | { kind: "device-control"; mac: string };

interface DialogsValue {
  openZoneForm: (zone?: Zone, onCreated?: (zone: Zone) => void) => void;
  confirmDeleteZone: (zone: Zone, onDeleted?: () => void) => void;
  openZoneEffects: (zone: Zone) => void;
  openDeviceForm: (opts?: { device?: DeviceView; zoneSlug?: string }) => void;
  confirmDeleteDevice: (device: DeviceView) => void;
  openDevice: (device: DeviceView) => void;
}

const DialogsContext = createContext<DialogsValue | null>(null);

/** Diyalog açılış sayacı — `key` olarak verilir, her açılış taze state alır. */
let openSeq = 0;

export function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<(Dialog & { seq: number }) | null>(null);
  const open = (d: Dialog) => setDialog({ ...d, seq: ++openSeq });
  const close = () => setDialog(null);

  const value: DialogsValue = {
    openZoneForm: (zone, onCreated) => open({ kind: "zone-form", zoneId: zone?.id, onCreated }),
    confirmDeleteZone: (zone, onDeleted) => open({ kind: "zone-delete", zoneId: zone.id, onDeleted }),
    openZoneEffects: (zone) => open({ kind: "zone-effects", zoneId: zone.id }),
    openDeviceForm: (opts) =>
      open({ kind: "device-form", mac: opts?.device?.deviceId, zoneSlug: opts?.zoneSlug }),
    confirmDeleteDevice: (device) => open({ kind: "device-delete", mac: device.deviceId }),
    openDevice: (device) => open({ kind: "device-control", mac: device.deviceId }),
  };

  return (
    <DialogsContext.Provider value={value}>
      {children}
      {dialog ? <ActiveDialog key={dialog.seq} dialog={dialog} onClose={close} /> : null}
    </DialogsContext.Provider>
  );
}

export function useDialogs(): DialogsValue {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs yalnızca müşteri paneli içinde kullanılabilir");
  return ctx;
}

function ActiveDialog({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const lighting = useLighting();
  const { zones, devices } = lighting;
  const zone =
    "zoneId" in dialog && dialog.zoneId ? zones.find((z) => z.id === dialog.zoneId) : undefined;
  const device =
    "mac" in dialog && dialog.mac ? devices.find((d) => d.deviceId === dialog.mac) : undefined;

  switch (dialog.kind) {
    case "zone-form":
      // Düzenlenen bölge bu arada silindiyse/taşındıysa formu açık tutma.
      if (dialog.zoneId && !zone) return null;
      return <ZoneDialog zone={zone} onClose={onClose} onCreated={dialog.onCreated} />;

    case "zone-delete":
      return zone ? (
        <DeleteZone zone={zone} onClose={onClose} onDeleted={dialog.onDeleted} />
      ) : null;

    case "zone-effects":
      return zone ? (
        <EffectPicker
          open
          title={`${zone.name} — Efektler`}
          activeFx={zone.activeFx}
          onClose={onClose}
          onPick={(n, text) => {
            lighting.applyEffect([zone.id], n, text);
            onClose();
          }}
          onStop={() => {
            lighting.stopEffect([zone.id]);
            onClose();
          }}
        />
      ) : null;

    case "device-form":
      if (dialog.mac && !device) return null;
      return <DeviceDialog device={device} zoneSlug={dialog.zoneSlug} onClose={onClose} />;

    case "device-delete":
      return device ? <DeleteDevice device={device} onClose={onClose} /> : null;

    case "device-control": {
      if (!device) return null;
      // "Tüm cihaz" seed'i cihazın bölgesinin komut snapshot'ından gelir (son
      // bölge/"Tüm Sistem" komutunu yansıtsın diye); bölge yoksa telemetri.
      const z = zones.find((zn) => zn.id === device.zoneSlug);
      return (
        <DeviceControlModal
          device={device}
          initialOn={z ? z.isOn : device.relayStatus === "on"}
          initialBrightness={z ? z.brightness : (device.brightness ?? 0)}
          onClose={onClose}
        />
      );
    }
  }
}

function ConfirmDelete({
  title,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Silinemedi");
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            İptal
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-[10px] bg-danger px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Siliniyor…" : "Sil"}
          </button>
        </>
      }
    >
      {error ? (
        <p className="mb-3 rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
      ) : null}
      <div className="text-sm leading-relaxed text-ink-2">{children}</div>
    </Modal>
  );
}

function DeleteZone({
  zone,
  onClose,
  onDeleted,
}: {
  zone: Zone;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { devices, deleteZone } = useLighting();
  const count = devices.filter((d) => d.zoneSlug === zone.id).length;
  return (
    <ConfirmDelete
      title="Bölgeyi sil"
      onClose={onClose}
      onConfirm={async () => {
        await deleteZone(zone.id);
        onDeleted?.();
      }}
    >
      <p>
        <span className="font-semibold text-text">{zone.name}</span> bölgesi
        {count > 0 ? ` ve bağlı ${count} cihazın kayıtları` : ""} kalıcı olarak silinecek.
      </p>
      <p className="mt-2 text-[13px] text-muted">
        Bölgenin kısa adı (<code className="font-mono">{zone.id}</code>) bir daha kullanılmaz: bu
        adla flaşlanmış cihazlar o topic&apos;i dinlemeye devam eder.
      </p>
    </ConfirmDelete>
  );
}

function DeleteDevice({ device, onClose }: { device: DeviceView; onClose: () => void }) {
  const { deleteDevice } = useLighting();
  return (
    <ConfirmDelete
      title="Cihazı sil"
      onClose={onClose}
      onConfirm={() => deleteDevice(device.deviceId)}
    >
      <p>
        <span className="font-mono text-text">{formatMac(device.deviceId)}</span>
        {device.name ? ` (${device.name})` : ""} cihazı ve tüm kayıtları (lambalar, telemetri,
        arıza geçmişi) silinecek.
      </p>
    </ConfirmDelete>
  );
}
