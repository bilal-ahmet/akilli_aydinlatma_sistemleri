"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Zone, DeviceView, OpenFault } from "@/app/_lib/types";
import type { LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { useReconcile } from "@/app/_lib/useReconcile";
import { describeDeviceError } from "@/lib/deviceErrors";
import { faultLabel } from "@/lib/faults";
import { formatMac } from "@/lib/mac";
import { Modal } from "./Modal";
import { DeviceControlModal } from "./DeviceControlModal";

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

/**
 * Son telemetriyi kısa metne çevirir: "42°C · -67 dBm". Açık/kapalı ve parlaklık
 * (%) BİLEREK gösterilmez — onlar cihazın telemetri agregatıydı ve "Tüm cihaz"
 * kontrolüyle (son komut) karışıyordu; cihaz durumu modaldeki kontrolde görülür.
 */
function telemetry(d: DeviceView): string | null {
  const parts: string[] = [];
  if (typeof d.temperature === "number") parts.push(`${d.temperature}°C`);
  if (typeof d.rssi === "number") parts.push(`${d.rssi} dBm`);
  return parts.length ? parts.join(" · ") : null;
}

export function DeviceManager({
  zones,
  faultsByDevice,
}: {
  zones: Zone[];
  /** Cihaz MAC'i → o cihazda O AN süren lamba arızaları. */
  faultsByDevice: Map<string, OpenFault[]>;
}) {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [mac, setMac] = useState("");
  const [zoneSlug, setZoneSlug] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeviceView | null>(null);
  const [controlling, setControlling] = useState<DeviceView | null>(null);

  // Bölge başlığına tıklanınca o bölgenin cihazları açılır/kapanır. Cihazlar
  // artık bağlı oldukları bölgenin altında gruplu duruyor (bölge ↔ cihaz bağını
  // görünür kılmak için); başlangıçta hepsi kapalı — "bölgeye tıkla, cihazlar gelsin".
  const [expandedZones, setExpandedZones] = useState<Set<string>>(new Set());
  function toggleZone(key: string) {
    setExpandedZones((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Düzenleme (bölge / isim) — MAC değiştirilemez.
  const [editing, setEditing] = useState<DeviceView | null>(null);
  const [editZoneSlug, setEditZoneSlug] = useState("");
  const [editName, setEditName] = useState("");

  const loadDevices = useCallback(() => {
    fetch("/api/devices")
      .then((r) => r.json())
      .then((j) => setDevices(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDevices();
  }, [loadDevices]);

  // SSE kaçarsa liste bayat kalmasın (bu bileşen komut göndermiyor, bu yüzden
  // taze veriyi ezme riski yok).
  useReconcile(loadDevices);

  /**
   * Cihaz listesini SSE ile canlı tut — sayfa yenilemeden:
   *  - `ack`       → hata rozeti (hata metnini yaz, başarılı yanıtta temizle;
   *                  kalıcı değer devices.last_error'da) + son görülme
   *  - `telemetry` → cihaz-seviyesi durum (açık/kapalı, %, son görülme).
   *                  Kanal bazlı olaylar atlanır: satırda cihaz agregatı var,
   *                  onu backend zaten cihaz-seviyesi olayda gönderiyor.
   */
  const onLive = useCallback((e: LiveEvent) => {
    if (!e.deviceId) return;
    if (e.kind !== "ack" && e.kind !== "telemetry") return;
    if (e.kind === "telemetry" && typeof e.channel === "number") return;

    setDevices((ds) =>
      ds.map((d) => {
        if (d.deviceId !== e.deviceId) return d;
        const next = { ...d, lastSeen: e.at };
        if (e.kind === "ack") {
          next.lastError = e.error ?? null;
          next.lastErrorAt = e.error ? e.at : null;
          return next;
        }
        if (typeof e.isOn === "boolean") next.relayStatus = e.isOn ? "on" : "off";
        if (typeof e.brightness === "number") next.brightness = e.brightness;
        return next;
      }),
    );
  }, []);
  useLiveStatus(onLive);

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

  function openEdit(d: DeviceView) {
    setEditing(d);
    setEditZoneSlug(d.zoneSlug ?? zones[0]?.id ?? "");
    setEditName(d.name ?? "");
    setError(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || !editZoneSlug) return;
    const target = editing;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/devices/${target.deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoneSlug: editZoneSlug, name: editName.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Hata (${res.status})`);
      // Yanıt yalnızca kayıt alanlarını taşır; telemetri satırını korumak için
      // mevcut satırın üzerine yalnızca değişenleri yaz.
      const patch = j.data as DeviceView;
      setDevices((ds) =>
        ds.map((d) =>
          d.deviceId === target.deviceId
            ? { ...d, name: patch.name, zoneSlug: patch.zoneSlug, zoneName: patch.zoneName }
            : d,
        ),
      );
      setEditing(null);
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

  // Cihazları bölgeye göre grupla — bölge sırasını koru, bölgesi olmayan (ya da
  // bilinmeyen bölgeye işaret eden) cihazlar en sona ayrı bir gruba düşer.
  const groups = useMemo(() => {
    const byZone = new Map<string, DeviceView[]>();
    for (const d of devices) {
      const key = d.zoneSlug ?? "__none__";
      const arr = byZone.get(key) ?? [];
      arr.push(d);
      byZone.set(key, arr);
    }
    const out: { key: string; name: string; devices: DeviceView[] }[] = [];
    const known = new Set(zones.map((z) => z.id));
    for (const z of zones) {
      const ds = byZone.get(z.id);
      if (ds && ds.length) out.push({ key: z.id, name: z.name, devices: ds });
    }
    // zones listesinde olmayan bir slug'a bağlı cihazlar (senkron dışı durum)
    for (const [key, ds] of byZone) {
      if (key === "__none__" || known.has(key)) continue;
      out.push({ key, name: ds[0].zoneName ?? key, devices: ds });
    }
    const none = byZone.get("__none__");
    if (none && none.length) out.push({ key: "__none__", name: "Bölge atanmamış", devices: none });
    return out;
  }, [zones, devices]);

  /** Tek bir cihaz satırı — bölge grubunun içinde listelenir. */
  const renderDevice = (d: DeviceView) => {
    const tel = telemetry(d);
    const deviceFaults = faultsByDevice.get(d.deviceId) ?? [];
    return (
      <li key={d.id} className="flex items-center justify-between gap-3 px-2 py-1 sm:pl-5">
        <button
          type="button"
          onClick={() => setControlling(d)}
          title="Cihazı kontrol et"
          className="flex min-w-0 flex-1 flex-col items-start rounded-lg px-2 py-2 text-left transition-colors hover:bg-glow/10"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm text-text">{formatMac(d.deviceId)}</span>
            {d.lastError ? (
              <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                komut hatası
              </span>
            ) : null}
            {deviceFaults.length > 0 ? (
              <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                arıza · {deviceFaults.length} lamba
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 text-xs text-muted">
            {d.name ? `${d.name} · ` : ""}son görülme: {formatSeen(d.lastSeen)}
          </span>
          {tel ? <span className="mt-0.5 font-mono text-[11px] text-accent">{tel}</span> : null}
          {d.lastError ? (
            <span className="mt-0.5 text-[11px] text-danger">
              {describeDeviceError(d.lastError).cause}
              {d.lastErrorAt ? ` · ${formatSeen(d.lastErrorAt)}` : ""}
            </span>
          ) : null}
          {deviceFaults.length > 0 ? (
            <span className="mt-0.5 text-[11px] text-danger">
              {deviceFaults
                .map((f) => `Lamba ${f.channel} — ${faultLabel(f.code)}`)
                .join(", ")}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => openEdit(d)}
          aria-label={`${d.deviceId} düzenle`}
          title="Bölge / isim düzenle"
          className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-glow/15 hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
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
  };

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
          <div className="divide-y divide-border">
            {groups.map((g) => {
              const isOpen = expandedZones.has(g.key);
              const errCount = g.devices.filter((d) => d.lastError).length;
              const faultCount = g.devices.filter(
                (d) => (faultsByDevice.get(d.deviceId)?.length ?? 0) > 0,
              ).length;
              return (
                <div key={g.key}>
                  <button
                    type="button"
                    onClick={() => toggleZone(g.key)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-glow/10"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                    <span className="truncate font-display text-sm font-semibold text-text">{g.name}</span>
                    <span className="shrink-0 text-xs text-muted">{g.devices.length} cihaz</span>
                    {errCount > 0 ? (
                      <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                        komut hatası · {errCount}
                      </span>
                    ) : null}
                    {faultCount > 0 ? (
                      <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                        arıza · {faultCount}
                      </span>
                    ) : null}
                  </button>
                  {isOpen ? (
                    <ul className="divide-y divide-border border-t border-border bg-panel-2/40">
                      {g.devices.map((d) => renderDevice(d))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
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

      {/* Cihaz düzenle (bölge / isim) */}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Cihazı düzenle">
        {error ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <p className="mb-4 font-mono text-xs text-muted">
          {editing ? formatMac(editing.deviceId) : ""}
        </p>
        <form onSubmit={submitEdit} className="flex flex-col gap-4">
          <div>
            <label className={labelCls} htmlFor="dv-edit-zone">Bölge *</label>
            <select
              id="dv-edit-zone"
              className={inputCls}
              value={editZoneSlug}
              onChange={(e) => setEditZoneSlug(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
            {editing && editZoneSlug !== editing.zoneSlug ? (
              <p className="mt-2 rounded-lg border border-accent/40 bg-glow/10 px-3 py-2 text-[11px] leading-relaxed text-text">
                <span className="font-semibold text-accent">
                  Cihazın yeniden flaşlanması gerekir.
                </span>{" "}
                Cihaz hangi bölge komutlarını dinleyeceğini firmware&apos;deki{" "}
                <code className="font-mono">ZONE_SLUG</code>&apos;tan bilir. Bu değişiklik
                yalnızca dashboard kaydını taşır: cihaz flaşlanana kadar{" "}
                <span className="font-mono">{editing.zoneSlug ?? "eski bölge"}</span> komutlarını
                almaya devam eder, <span className="font-mono">{editZoneSlug}</span> komutlarını
                almaz. Tekil ve &quot;Tüm Sistem&quot; komutları etkilenmez.
              </p>
            ) : null}
          </div>
          <div>
            <label className={labelCls} htmlFor="dv-edit-name">İsim (opsiyonel)</label>
            <input
              id="dv-edit-name"
              className={inputCls}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Örn. Köşe direği"
            />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">İptal</button>
            <button type="submit" disabled={submitting || !editZoneSlug} className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50">
              {submitting ? "Kaydediliyor…" : "Kaydet"}
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

      {/* Cihaz kontrol paneli (cihaz + lamba bazlı komut). "Tüm cihaz" seed'i
          cihazın bölgesinin komut snapshot'ından gelir (son bölge/"Tüm Sistem"
          komutunu yansıtsın diye); bölge yoksa cihazın telemetri değeri. */}
      {controlling
        ? (() => {
            const z = zones.find((zn) => zn.id === controlling.zoneSlug);
            return (
              <DeviceControlModal
                key={controlling.deviceId}
                device={controlling}
                initialOn={z ? z.isOn : controlling.relayStatus === "on"}
                initialBrightness={z ? z.brightness : (controlling.brightness ?? 0)}
                onClose={() => setControlling(null)}
              />
            );
          })()
        : null}
    </section>
  );
}
