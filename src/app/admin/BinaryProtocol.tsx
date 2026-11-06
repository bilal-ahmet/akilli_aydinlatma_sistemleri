"use client";

import { useCallback, useEffect, useState } from "react";
import { useReconcile } from "@/app/_lib/useReconcile";
import { useNow } from "@/app/_lib/useNow";
import { formatAgo } from "@/app/_lib/deviceHealth";
import { formatMac } from "@/lib/mac";
import type { BinProtoSnapshot } from "@/lib/binUplink";

/** Ret/atlama nedenlerinin okunur adları (lib/binUplink.ts BinOutcome). */
const OUTCOME_LABEL: Record<string, string> = {
  FIELD: "tanımsız alan",
  MISSING_FIELD: "eksik alan",
  CRC: "CRC hatası",
  TOO_SHORT: "çok kısa",
  VERSION: "bilinmeyen versiyon",
  TRUNCATED: "taşma",
  NO_TYPE: "TYPE yok",
  UNKNOWN_TYPE: "bilinmeyen tip",
  LORA: "LoRa (desteklenmiyor)",
  GATEWAY: "gateway kimliği",
};

/**
 * Binary protokol (Meven:<MAC>/bin) alımının durumu. Doküman "tabloda olmayan
 * alan gelirse paketi atın ve alarm üretin" diyor: alarm buradaki kırmızı
 * banttır. Hiç binary trafik yokken kart gösterilmez.
 */
export function BinaryProtocol() {
  const [snap, setSnap] = useState<BinProtoSnapshot | null>(null);
  const now = useNow(15_000);

  const load = useCallback(() => {
    fetch("/api/admin/binproto")
      .then((r) => r.json())
      .then((j) => {
        if (j?.data) setSnap(j.data as BinProtoSnapshot);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load);

  if (!snap || (snap.devices.length === 0 && snap.recent.length === 0)) return null;

  const accepted = snap.counts.accepted ?? 0;
  const problems = Object.entries(snap.counts).filter(([k, n]) => k !== "accepted" && (n ?? 0) > 0);
  const binDevices = snap.devices.filter((d) => d.lastValidAt !== null);

  return (
    <section aria-label="Binary protokol" className="rounded-2xl border border-border bg-panel p-5">
      <h2 className="font-display text-base font-semibold text-text">Binary protokol</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        Yeni firmware&apos;li cihazlar verilerini <code className="font-mono">Meven:&lt;MAC&gt;/bin</code>
        &apos;e binary basar; sunucu çözüp JSON ile aynı yoldan işler. Sayaçlar sunucunun son
        açılışından beri ({formatAgo(snap.since, now)}).
      </p>

      {snap.alarm ? (
        <div role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="font-semibold">
            Cihaz sunucunun tanımadığı bir alan gönderiyor, paketleri atılıyor.
          </p>
          <p className="mt-1 text-xs">
            <span className="font-mono">{formatMac(snap.alarm.mac)}</span>
            {snap.alarm.label ? ` (${snap.alarm.label})` : ""} · {formatAgo(snap.alarm.at, now)} ·{" "}
            {snap.alarm.detail}. Firmware yeni bir alan tablosu kullanıyor;{" "}
            <code className="font-mono">src/lib/binproto/fields.ts</code> güncellenip deploy edilmeli.
            O zamana kadar bu cihazın verisi panelde görünmez.
          </p>
        </div>
      ) : null}

      <p className="mt-3 text-sm text-text">
        {binDevices.length} cihaz binary gönderiyor · {accepted.toLocaleString("tr-TR")} paket işlendi
        {problems.length > 0
          ? ` · ${problems.map(([k, n]) => `${OUTCOME_LABEL[k] ?? k}: ${n}`).join(", ")}`
          : " · ret yok"}
        {snap.duplicateJson > 0 ? ` · atlanan JSON kopyası: ${snap.duplicateJson}` : ""}
      </p>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted hover:text-text">Cihazlar ({snap.devices.length})</summary>
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {snap.devices.map((d) => (
            <li key={d.mac} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
              <span className="font-mono text-text">{formatMac(d.mac)}</span>
              <span className="text-muted">{d.label ?? "kayıtsız"}</span>
              <span className="text-muted">
                son paket {formatAgo(d.lastAt, now)} · {d.lastType ?? "—"} · {d.frames} paket
              </span>
              {d.lastReject ? (
                <span className="text-danger">
                  son ret: {OUTCOME_LABEL[d.lastReject.outcome] ?? d.lastReject.outcome} (
                  {formatAgo(d.lastReject.at, now)})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>

      {snap.recent.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted hover:text-text">
            Son reddedilen paketler ({snap.recent.length})
          </summary>
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {snap.recent.map((r, i) => (
              <li key={`${r.mac}-${r.at}-${i}`} className="py-1.5">
                <span className="font-mono text-text">{formatMac(r.mac)}</span>{" "}
                <span className="text-muted">
                  {formatAgo(r.at, now)} · {OUTCOME_LABEL[r.outcome] ?? r.outcome} · {r.detail}
                </span>
                <div className="mt-0.5 break-all font-mono text-[11px] text-muted">{r.hex}</div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
