"use client";

import { useCallback, useEffect, useState } from "react";
import { useReconcile } from "@/app/_lib/useReconcile";
import { formatMac } from "@/lib/mac";
import type { ZoneSyncSnapshot } from "@/lib/zoneSync/engine";
import type { ZoneSyncStatus } from "@/lib/zoneSync/plan";

const STATUS_LABEL: Record<ZoneSyncStatus, string> = {
  synced: "senkron",
  pending: "bekliyor",
  no_response: "yanıtsız",
  error: "hata",
  unsupported: "desteklemiyor",
  unknown: "bilinmiyor",
};

const MODE_TEXT: Record<ZoneSyncSnapshot["mode"], string> = {
  on: "açık — farklar cihazlara uygulanır",
  observe: "izleme — yalnızca zone_list, cihazda değişiklik yok",
  off: "kapalı — zone komutu gönderilmez",
};

/**
 * Dinamik bölge aboneliği (lib/zoneSync): cihazların dinlediği bölge ve alt
 * grup topic'leri istenenle aynı mı. Senkron dışı cihazlar istenen /
 * cihazdaki listeyle gösterilir; cihaza gönderilemeyen (32 karakteri aşan,
 * kural dışı) slug'lar ayrıca uyarılır. Hiç kayıt yoksa kart gösterilmez.
 */
export function ZoneSync() {
  const [snap, setSnap] = useState<ZoneSyncSnapshot | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/zone-sync")
      .then((r) => r.json())
      .then((j) => {
        if (j?.data) setSnap(j.data as ZoneSyncSnapshot);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load);

  if (!snap) return null;
  const counts = Object.entries(snap.counts).filter(([, n]) => (n ?? 0) > 0);
  const known = counts.some(([k]) => k !== "unknown");
  if (!known && snap.devices.length === 0 && snap.invalidSlugs.length === 0) return null;

  return (
    <section aria-label="Bölge senkronu" className="rounded-2xl border border-border bg-panel p-5">
      <h2 className="font-display text-base font-semibold text-text">Bölge aboneliği (zone sync)</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        Yeni firmware dinlediği bölge/alt grup topic&apos;lerini NVS&apos;te tutar; liste panelden{" "}
        <code className="font-mono">Meven:&lt;MAC&gt;/cmd</code>&apos;ye zone_add / zone_remove / zone_clear
        ile yönetilir. Mod (<code className="font-mono">MQTT_ZONE_SYNC</code>): {MODE_TEXT[snap.mode]}.
        Uçuşta {snap.inflight}, sırada {snap.waiting}.
      </p>

      <p className="mt-3 text-sm text-text">
        {counts.map(([k, n]) => `${n} ${STATUS_LABEL[k as ZoneSyncStatus] ?? k}`).join(" · ") || "Kayıt yok"}
      </p>

      {snap.invalidSlugs.length > 0 ? (
        <div role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="font-semibold">Cihaza gönderilemeyen slug&apos;lar (1-32 karakter, a-z 0-9 -)</p>
          <p className="mt-1 font-mono text-xs">
            {snap.invalidSlugs.map((s) => `${s.slug}${s.customer ? ` (${s.customer})` : ""}`).join(", ")}
          </p>
        </div>
      ) : null}

      {snap.devices.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Cihaz</th>
                <th className="py-1.5 pr-3 font-medium">Durum</th>
                <th className="py-1.5 pr-3 font-medium">İstenen</th>
                <th className="py-1.5 pr-3 font-medium">Cihazdaki</th>
                <th className="py-1.5 font-medium">Son hata</th>
              </tr>
            </thead>
            <tbody>
              {snap.devices.map((d) => (
                <tr key={d.mac} className="border-t border-border align-top">
                  <td className="py-1.5 pr-3">
                    <span className="font-mono">{formatMac(d.mac)}</span>
                    <span className="block text-muted">
                      {d.customer ?? (d.registered ? "—" : "kayıtsız (temizlik)")}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {STATUS_LABEL[d.status]}
                    {d.inflightOp ? <span className="block text-muted">{d.inflightOp}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 font-mono">{d.desired?.join(", ") || "∅"}</td>
                  <td className="py-1.5 pr-3 font-mono">
                    {d.reported === null || d.reported === undefined ? "bilinmiyor" : d.reported.join(", ") || "∅"}
                  </td>
                  <td className="py-1.5 text-danger">{d.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
