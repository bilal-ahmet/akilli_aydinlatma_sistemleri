"use client";

import { useState } from "react";
import type { GatewayView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, useTechnical } from "@/app/_lib/panel";
import { GATEWAY_TYPES, gatewayTypeLabel, type GatewayType } from "@/lib/gateways";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";

/**
 * Yeni gateway / gateway düzenleme diyaloğu. Kimlik (GW_ID) yalnızca kayıtta
 * girilir: topic'ler ona bağlı, sonradan değiştirilemez.
 *
 * Parent `key` ile yeniden mount eder (açılışta taze state).
 */
export function GatewayDialog({
  gateway,
  onClose,
  onSaved,
}: {
  /** Verilirse düzenleme modu. */
  gateway?: GatewayView;
  onClose: () => void;
  onSaved: (gateway: GatewayView) => void;
}) {
  const api = useApi();
  const technical = useTechnical();
  const { zones } = useLighting();
  const [gatewayId, setGatewayId] = useState("");
  const [type, setType] = useState<GatewayType>(
    (GATEWAY_TYPES as readonly string[]).includes(gateway?.type ?? "")
      ? (gateway!.type as GatewayType)
      : "thread_br",
  );
  const [name, setName] = useState(gateway?.name ?? "");
  const [zoneSlug, setZoneSlug] = useState(gateway?.zoneSlug ?? "");
  const [location, setLocation] = useState(gateway?.location ?? "");
  const [notes, setNotes] = useState(gateway?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !submitting && (gateway ? true : gatewayId.trim() !== "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const body = { type, name, zoneSlug, location, notes };
    try {
      const res = await fetch(
        api(gateway ? `/api/gateways/${gateway.gatewayId}` : "/api/gateways"),
        {
          method: gateway ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            gateway
              ? body
              : // Yeni kayıtta boş alanlar hiç gönderilmez.
                {
                  gatewayId: gatewayId.trim(),
                  type,
                  name: name.trim() || undefined,
                  zoneSlug: zoneSlug || undefined,
                  location: location.trim() || undefined,
                  notes: notes.trim() || undefined,
                },
          ),
        },
      );
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Kaydedilemedi (${res.status})`);
      onSaved(j.data as GatewayView);
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
      title={gateway ? "Ağ geçidini düzenle" : "Yeni ağ geçidi"}
      subtitle={
        gateway ? (
          <>
            {technical ? "GW_ID " : "Kod "}
            <span className="font-mono">{formatMac(gateway.gatewayId)}</span>
          </>
        ) : technical ? (
          "Sahadaki gateway'i (Thread Border Router, 4G/WiFi router…) kaydedin."
        ) : (
          "Cihazların ağa bağlandığı kutuyu kaydedin."
        )
      }
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            İptal
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-glow h-10 px-5 text-sm">
            {submitting ? "Kaydediliyor…" : gateway ? "Kaydet" : "Ağ geçidini ekle"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        {gateway ? null : (
          <div>
            <label className="field-label" htmlFor="gw-id">
              {technical ? "Gateway kimliği (MAC)" : "Ağ geçidi kodu"}
            </label>
            <input
              id="gw-id"
              className="field font-mono"
              value={gatewayId}
              onChange={(e) => setGatewayId(e.target.value)}
              placeholder="A8:42:E3:12:34:56"
              autoFocus
              spellCheck={false}
              autoCapitalize="characters"
            />
            <p className="mt-2 text-[12.5px] leading-normal text-muted">
              {technical ? (
                <>
                  Gateway&apos;in MQTT&apos;de kullandığı kimlik (
                  <span className="font-mono text-ink-2">Meven:&lt;GW_ID&gt;/health</span>). İki
                  noktalı ya da noktasız girebilirsiniz.
                </>
              ) : (
                "Ağ geçidinin etiketindeki kodu yazın."
              )}
            </p>
          </div>
        )}

        <div>
          <label className="field-label" htmlFor="gw-type">Tür</label>
          <select
            id="gw-type"
            className="field"
            value={type}
            onChange={(e) => setType(e.target.value as GatewayType)}
          >
            {GATEWAY_TYPES.map((t) => (
              <option key={t} value={t}>
                {gatewayTypeLabel(t, technical)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="gw-name">
            İsim <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <input
            id="gw-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Park girişi kabini"
          />
        </div>

        <div>
          <label className="field-label" htmlFor="gw-zone">
            Bölge <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <select
            id="gw-zone"
            className="field"
            value={zoneSlug}
            onChange={(e) => setZoneSlug(e.target.value)}
          >
            <option value="">—</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="gw-location">
            Konum <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <input
            id="gw-location"
            className="field"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Örn. Trafo binası, 2. direk yanı"
          />
        </div>

        <div>
          <label className="field-label" htmlFor="gw-notes">
            Not <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <textarea
            id="gw-notes"
            rows={3}
            className="field !h-auto py-2.5"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
