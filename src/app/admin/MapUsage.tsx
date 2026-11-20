"use client";

import { useCallback, useEffect, useState } from "react";
import { useReconcile } from "@/app/_lib/useReconcile";
import { formatInt } from "@/app/_lib/format";

interface Counter {
  configured: boolean;
  today: number;
  dailyLimit: number;
  month: number;
  monthlyLimit: number;
}

interface Snapshot extends Counter {
  routes?: Counter;
  geocodes?: Counter;
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const full = used >= limit;
  return (
    <div className="min-w-[200px] flex-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className={`font-mono tabular-nums ${full ? "text-danger" : "text-text"}`}>
          {formatInt(used)} / {formatInt(limit)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div
          className={`h-full rounded-full ${full ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

const isFull = (c: Counter) => c.today >= c.dailyLimit || c.month >= c.monthlyLimit;

/**
 * Google Maps kullanım sayacı. Haritalar sayfası Google ile açılır; sınır
 * dolunca OpenStreetMap çizilir (lib/mapUsage.ts). Yol tarifi (Routes API)
 * ayrı sayılır; sınırda dış "Google Haritalar'da aç" bağlantısına düşer.
 * Hiçbiri yapılandırılmamışsa kart gösterilmez.
 */
export function MapUsage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/map-usage")
      .then((r) => r.json())
      .then((j) => {
        if (j?.data) setSnap(j.data as Snapshot);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load);

  const routes = snap?.routes?.configured ? snap.routes : null;
  const geocodes = snap?.geocodes?.configured ? snap.geocodes : null;
  if (!snap || (!snap.configured && !routes)) return null;

  return (
    <section aria-label="Google harita kullanımı" className="rounded-2xl border border-border bg-panel p-5">
      <h2 className="font-display text-base font-semibold text-text">Google harita kullanımı</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        Haritalar sayfası Google Maps ile açılır; her harita kurulumu bir yükleme, her yol tarifi bir rota isteği
        sayılır (tüm müşteriler ortak). Sınır dolunca harita kendiliğinden OpenStreetMap&apos;e, yol tarifi Google
        Haritalar bağlantısına geçer; ücret oluşmaz. Günlük sayaç UTC gece yarısında, aylık sayaç ay başında
        sıfırlanır.
      </p>
      {snap.configured ? (
        <>
          <h3 className="mt-4 text-xs font-semibold text-ink-2">Harita yüklemeleri</h3>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-4">
            <Meter label="Bugün" used={snap.today} limit={snap.dailyLimit} />
            <Meter label="Bu ay" used={snap.month} limit={snap.monthlyLimit} />
          </div>
          {isFull(snap) ? (
            <p className="mt-3 text-xs font-medium text-danger">
              Sınır doldu: Haritalar sayfası şu an OpenStreetMap ile açılıyor.
            </p>
          ) : null}
        </>
      ) : null}
      {routes ? (
        <>
          <h3 className="mt-4 text-xs font-semibold text-ink-2">Yol tarifi (Routes API)</h3>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-4">
            <Meter label="Bugün" used={routes.today} limit={routes.dailyLimit} />
            <Meter label="Bu ay" used={routes.month} limit={routes.monthlyLimit} />
          </div>
          {isFull(routes) ? (
            <p className="mt-3 text-xs font-medium text-danger">
              Sınır doldu: yol tarifi haritada çizilmiyor, Google Haritalar bağlantısı veriliyor.
            </p>
          ) : null}
        </>
      ) : null}
      {geocodes ? (
        <>
          <h3 className="mt-4 text-xs font-semibold text-ink-2">Adres bulma (Geocoding API)</h3>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-4">
            <Meter label="Bugün" used={geocodes.today} limit={geocodes.dailyLimit} />
            <Meter label="Bu ay" used={geocodes.month} limit={geocodes.monthlyLimit} />
          </div>
          {isFull(geocodes) ? (
            <p className="mt-3 text-xs font-medium text-danger">
              Sınır doldu: adres başlangıcı doğrudan rota servisine veriliyor (aday listesi yok).
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
