"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useReconcile } from "@/app/_lib/useReconcile";
import { useNow } from "@/app/_lib/useNow";
import { formatAgo } from "@/app/_lib/deviceHealth";
import { GATEWAY_TYPES, gatewayTypeLabel, isGatewayType, type GatewayType } from "@/lib/gateways";
import { formatMac } from "@/lib/mac";

interface Discovered {
  gatewayId: string;
  type: string | null;
  firmwareVersion: string | null;
  firstSeen: string;
  lastSeen: string;
}

/**
 * MQTT'ye gateway türüyle yayın yapan ama hiçbir müşteriye kayıtlı olmayan
 * gateway'ler. Liste boşken kart gösterilmez. Kayıt edilen gateway listeden
 * çıkar; ad/konum gibi ayrıntılar müşterinin "Ağ geçitleri" sayfasında girilir.
 */
export function DiscoveredGateways({ customers }: { customers: { slug: string; name: string }[] }) {
  const [items, setItems] = useState<Discovered[]>([]);
  const [registered, setRegistered] = useState<{ gatewayId: string; slug: string; name: string }[]>([]);
  const now = useNow(15_000);

  const load = useCallback(() => {
    fetch("/api/admin/gateways/discovered")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.data)) setItems(j.data as Discovered[]);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load);

  if (items.length === 0 && registered.length === 0) return null;

  return (
    <section aria-label="Keşfedilen ağ geçitleri" className="rounded-2xl border border-border bg-panel p-5">
      <h2 className="font-display text-base font-semibold text-text">Keşfedilen ağ geçitleri</h2>
      <p className="mt-1 max-w-2xl text-xs text-muted">
        MQTT&apos;ye gateway türüyle (<code className="font-mono">&quot;type&quot;: &quot;thread_br&quot;</code> vb.)
        yayın yapan ama hiçbir müşteriye kayıtlı olmayan kimlikler (son 24 saat). Kayıt edilene
        kadar verileri saklanmaz.
      </p>

      {registered.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs">
          {registered.map((r) => (
            <li key={r.gatewayId} className="text-text">
              <span className="font-mono">{formatMac(r.gatewayId)}</span> {r.name} müşterisine kaydedildi ·{" "}
              <Link href={`/c/${r.slug}/ag-gecitleri`} className="font-medium text-accent hover:underline">
                Ağ geçitlerini aç
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-4 flex flex-col divide-y divide-border">
        {items.map((d) => (
          <DiscoveredRow
            key={d.gatewayId}
            item={d}
            now={now}
            customers={customers}
            onRegistered={(slug, name) => {
              setItems((xs) => xs.filter((x) => x.gatewayId !== d.gatewayId));
              setRegistered((rs) => [...rs, { gatewayId: d.gatewayId, slug, name }]);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function DiscoveredRow({
  item,
  now,
  customers,
  onRegistered,
}: {
  item: Discovered;
  now: number | null;
  customers: { slug: string; name: string }[];
  onRegistered: (slug: string, name: string) => void;
}) {
  const [slug, setSlug] = useState("");
  const [type, setType] = useState<GatewayType>(isGatewayType(item.type) ? item.type : "thread_br");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register() {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gateways?customer=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gatewayId: item.gatewayId, type }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Kaydedilemedi (${res.status})`);
      onRegistered(slug, customers.find((c) => c.slug === slug)?.name ?? slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kaydedilemedi");
      setBusy(false);
    }
  }

  const select =
    "rounded-lg border border-border bg-panel-2 px-2 py-1.5 text-sm text-text outline-none focus-visible:border-accent";

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="font-mono text-sm text-text">{formatMac(item.gatewayId)}</p>
        <p className="text-xs text-muted">
          {item.type ?? "tür yok"}
          {item.firmwareVersion ? ` · fw ${item.firmwareVersion}` : ""} · son haber{" "}
          {formatAgo(item.lastSeen, now)}
        </p>
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Tür"
          className={select}
          value={type}
          onChange={(e) => setType(e.target.value as GatewayType)}
        >
          {GATEWAY_TYPES.map((t) => (
            <option key={t} value={t}>
              {gatewayTypeLabel(t, true)}
            </option>
          ))}
        </select>
        <select aria-label="Müşteri" className={select} value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">Müşteri seçin…</option>
          {customers.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={register}
          disabled={!slug || busy}
          className="rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
        >
          {busy ? "Kaydediliyor…" : "Kaydet"}
        </button>
      </div>
    </li>
  );
}
