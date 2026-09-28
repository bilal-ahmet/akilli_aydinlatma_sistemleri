"use client";

import { useState } from "react";
import type { DeviceView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";

/**
 * Yeni cihaz / cihaz düzenleme diyaloğu. Düzenlemede yalnızca bölge ve isim
 * değişir — MAC cihazın kimliğidir, tüm telemetri ona bağlı.
 *
 * Parent `key` ile yeniden mount eder (açılışta taze state).
 */
export function DeviceDialog({
  device,
  zoneSlug: presetZone,
  onClose,
}: {
  /** Verilirse düzenleme modu. */
  device?: DeviceView;
  /** Yeni cihazda önceden seçili bölge (bölge detayından "+ Cihaz ekle"). */
  zoneSlug?: string;
  onClose: () => void;
}) {
  const { zones, createDevice, updateDevice } = useLighting();
  const [mac, setMac] = useState("");
  const [zoneSlug, setZoneSlug] = useState(
    device?.zoneSlug ?? presetZone ?? zones[0]?.id ?? "",
  );
  const [name, setName] = useState(device?.name ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const zoneChanged = device ? zoneSlug !== device.zoneSlug : false;
  const canSubmit = !submitting && zoneSlug !== "" && (device ? true : mac.trim() !== "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (device) await updateDevice(device.deviceId, { zoneSlug, name });
      else await createDevice({ mac: mac.trim(), zoneSlug, name });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={device ? "Cihazı düzenle" : "Yeni Cihaz"}
      subtitle={
        device ? (
          <span className="font-mono">{formatMac(device.deviceId)}</span>
        ) : (
          "ESP32 cihazını bir bölgeye bağlayın."
        )
      }
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            İptal
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-glow h-10 px-5 text-sm">
            {submitting ? "Kaydediliyor…" : device ? "Kaydet" : "Cihazı ekle"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        <div>
          <label className="field-label" htmlFor="dv-zone">Bölge</label>
          <select
            id="dv-zone"
            className="field"
            value={zoneSlug}
            onChange={(e) => setZoneSlug(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>
          {device && zoneChanged ? (
            <p className="mt-2 rounded-[10px] bg-accent-soft px-3 py-2 text-[12.5px] leading-relaxed text-text">
              <span className="font-semibold text-accent">Cihazın yeniden flaşlanması gerekir.</span>{" "}
              Cihaz hangi bölge komutlarını dinleyeceğini firmware&apos;deki{" "}
              <code className="font-mono">ZONE_SLUG</code>&apos;tan bilir. Bu değişiklik yalnızca
              dashboard kaydını taşır: cihaz flaşlanana kadar{" "}
              <span className="font-mono">{device.zoneSlug ?? "eski bölge"}</span> komutlarını almaya
              devam eder, <span className="font-mono">{zoneSlug}</span> komutlarını almaz. Tekil ve
              &quot;Tüm Sistem&quot; komutları etkilenmez.
            </p>
          ) : null}
        </div>

        {device ? null : (
          <div>
            <label className="field-label" htmlFor="dv-mac">MAC adresi</label>
            <input
              id="dv-mac"
              className="field font-mono"
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="A8:42:E3:12:34:56"
              autoFocus
              spellCheck={false}
              autoCapitalize="characters"
            />
            <p className="mt-2 text-[12.5px] leading-normal text-muted">
              İki noktalı ya da noktasız girebilirsiniz; sistemde{" "}
              <span className="font-mono text-ink-2">A842E3123456</span> olarak saklanır. ESP32
              firmware&apos;i kendi MAC&apos;ini bu formatta kullanır.
            </p>
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="dv-name">
            İsim <span className="font-normal text-muted">(opsiyonel)</span>
          </label>
          <input
            id="dv-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Köşe direği"
          />
        </div>
      </div>
    </Modal>
  );
}
