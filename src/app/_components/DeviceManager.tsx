"use client";

import { useEffect, useState } from "react";
import type { Zone, DeviceView } from "@/app/_lib/types";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

function formatSeen(iso: string | null): string {
  if (!iso) return "hiç bağlanmadı";
  return new Date(iso).toLocaleString("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** Son telemetriyi kısa metne çevirir: "açık · %75 · 42°C · -67 dBm". */
function telemetry(d: DeviceView): string | null {
  const parts: string[] = [];
  if (d.relayStatus) parts.push(d.relayStatus === "on" ? "açık" : "kapalı");
  if (typeof d.brightness === "number") parts.push(`%${d.brightness}`);
  if (typeof d.temperature === "number") parts.push(`${d.temperature}°C`);
  if (typeof d.rssi === "number") parts.push(`${d.rssi} dBm`);
  return parts.length ? parts.join(" · ") : null;
}

export function DeviceManager({ zones }: { zones: Zone[] }) {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [mac, setMac] = useState("");
  const [zoneSlug, setZoneSlug] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeviceView | null>(null);

  useEffect(() => {
    fetch("/api/devices")
      .then((r) => r.json())
      .then((j) => setDevices(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function openAdd() {
    setZoneSlug(zones[0]?.id ?? "");
    setMac("");
    setName("");
    setError(null);
    setAddOpen(true);
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!mac.trim() || !zoneSlug) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac: mac.trim(), zoneSlug, name: name.trim() || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Hata (${res.status})`);
      setDevices((ds) => [...ds, j.data].sort((a, b) => a.deviceId.localeCompare(b.deviceId)));
      setAddOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setSubmitting(false);
    }
  }

  async function doDelete() {
    if (!deleting) return;
    const target = deleting;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/devices/${target.deviceId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setDevices((ds) => ds.filter((d) => d.deviceId !== target.deviceId));
      setDeleting(null);
    } catch {
      setError("Cihaz silinemedi");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Cihazlar">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg font-bold text-text">Cihazlar</h2>
          <p className="text-xs text-muted">{devices.length} ESP32</p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          disabled={zones.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Yeni Cihaz
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-panel">
        {loading ? (
          <p className="p-5 text-sm text-muted">Yükleniyor…</p>
        ) : devices.length === 0 ? (
          <p className="p-5 text-sm text-muted">
            Henüz cihaz yok. Gerçek ESP32&apos;yi bağlamadan önce buradan MAC adresini ve bölgesini tanımla.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((d) => {
              const tel = telemetry(d);
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-text">{formatMac(d.deviceId)}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {d.zoneName ?? "bölge yok"}
                      {d.name ? ` · ${d.name}` : ""} · son görülme: {formatSeen(d.lastSeen)}
                    </p>
                    {tel ? <p className="mt-0.5 font-mono text-[11px] text-accent">{tel}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeleting(d)}
                    aria-label={`${d.deviceId} sil`}
                    title="Sil"
                    className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-danger/15 hover:text-danger"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Yeni cihaz */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Yeni Cihaz">
        {error ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <form onSubmit={submitAdd} className="flex flex-col gap-4">
          <div>
            <label className={labelCls} htmlFor="dv-zone">Bölge *</label>
            <select id="dv-zone" className={inputCls} value={zoneSlug} onChange={(e) => setZoneSlug(e.target.value)}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="dv-mac">MAC Adresi *</label>
            <input
              id="dv-mac"
              className={`${inputCls} font-mono`}
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="A8:42:E3:12:34:56"
            />
            <p className="mt-1 text-[11px] text-muted">
              İki noktalı ya da noktasız girebilirsin; sistemde <code>A842E3123456</code> olarak saklanır. ESP32 firmware&apos;ı kendi MAC&apos;ini bu formatta kullanır.
            </p>
          </div>
          <div>
            <label className={labelCls} htmlFor="dv-name">İsim (opsiyonel)</label>
            <input id="dv-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn. Köşe direği" />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={() => setAddOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">İptal</button>
            <button type="submit" disabled={submitting || !mac.trim()} className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50">
              {submitting ? "Kaydediliyor…" : "Ekle"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Sil onayı */}
      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Cihaz sil">
        <p className="text-sm text-muted">
          <span className="font-mono text-text">{deleting ? formatMac(deleting.deviceId) : ""}</span> cihazını silmek istediğine emin misin?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setDeleting(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">İptal</button>
          <button type="button" onClick={doDelete} disabled={submitting} className="rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50">
            {submitting ? "Siliniyor…" : "Sil"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
