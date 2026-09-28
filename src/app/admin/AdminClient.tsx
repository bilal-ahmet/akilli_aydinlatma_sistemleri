"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useReconcile } from "@/app/_lib/useReconcile";
import { formatInt } from "@/app/_lib/format";
import { Modal } from "@/app/_components/Modal";
import type { CustomerOverview } from "@/types/admin";
import type { Action } from "@/types/lighting";
import { CustomerForm, type CustomerFormValues } from "./CustomerForm";

function formatPower(w: number | null): string {
  if (w === null) return "—";
  if (w >= 1000) return `${(w / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} kW`;
  return `${Math.round(w).toLocaleString("tr-TR")} W`;
}

type GlobalCmd = { action: Action; value?: number; label: string };

const GLOBAL_CMDS: GlobalCmd[] = [
  { action: "on", label: "Tümünü aç" },
  { action: "off", label: "Tümünü kapat" },
];

/**
 * Admin ana ekranı: tüm müşteriler kart ızgarası. Karta tıklamak o müşterinin
 * dashboard'unu (/c/<slug>) tüm fonksiyonlarıyla açar. Sayılar 30 sn'de bir
 * ve sekme öne gelince tazelenir.
 */
export function AdminClient({ initialCustomers }: { initialCustomers: CustomerOverview[] }) {
  const router = useRouter();
  const [customers, setCustomers] = useState(initialCustomers);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [globalCmd, setGlobalCmd] = useState<GlobalCmd | null>(null);
  const [globalConfirm, setGlobalConfirm] = useState(false);
  const [globalResult, setGlobalResult] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/admin/customers")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setCustomers(j.data as CustomerOverview[]);
      })
      .catch(() => {});
  }, []);
  useReconcile(refresh);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    return customers.filter(
      (c) =>
        (showInactive || c.isActive) &&
        (!q ||
          c.name.toLocaleLowerCase("tr").includes(q) ||
          c.slug.includes(q) ||
          (c.contactName ?? "").toLocaleLowerCase("tr").includes(q)),
    );
  }, [customers, query, showInactive]);

  const totals = useMemo(() => {
    let zones = 0;
    let devices = 0;
    let online = 0;
    let faults = 0;
    let power = 0;
    let measured = false;
    for (const c of customers) {
      zones += c.zoneCount;
      devices += c.deviceCount;
      online += c.onlineDevices;
      faults += c.summary.faultyLamps;
      if (c.summary.powerW !== null) {
        power += c.summary.powerW;
        measured = true;
      }
    }
    return { zones, devices, online, faults, power: measured ? power : null };
  }, [customers]);

  async function createCustomer(values: CustomerFormValues) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Oluşturulamadı (${res.status})`);
      setCreateOpen(false);
      // Yeni müşterinin ayarlarına git: ilk kullanıcıyı açmak için.
      router.push(`/admin/customers/${j.data.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Oluşturulamadı");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendGlobal() {
    if (!globalCmd) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/command/global", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: globalCmd.action, value: globalCmd.value }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Gönderilemedi (${res.status})`);
      setGlobalResult(`“${globalCmd.label}” komutu tüm müşterilere gönderildi.`);
      setGlobalCmd(null);
    } catch (err) {
      setGlobalResult(err instanceof Error ? err.message : "Gönderilemedi");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Özet şeridi */}
      <section aria-label="Sistem özeti" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Müşteri", value: formatInt(customers.length) },
          { label: "Bölge", value: formatInt(totals.zones) },
          { label: "Cihaz (çevrimiçi)", value: `${formatInt(totals.devices)} (${formatInt(totals.online)})` },
          { label: "Arızalı lamba", value: formatInt(totals.faults), danger: totals.faults > 0 },
          { label: "Ölçülen güç", value: formatPower(totals.power) },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-panel p-4">
            <p className="text-xs text-muted">{s.label}</p>
            <p className={`mt-1 font-mono text-lg tabular-nums ${s.danger ? "text-danger" : "text-text"}`}>
              {s.value}
            </p>
          </div>
        ))}
      </section>

      {/* Müşteriler */}
      <section aria-label="Müşteriler">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h1 className="font-display text-lg font-bold text-text">Müşteriler</h1>
            <p className="text-xs text-muted">Bir müşteriye tıklayarak panelini açın</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ara…"
              aria-label="Müşteri ara"
              className="w-40 rounded-lg border border-border bg-panel-2 px-3 py-1.5 text-sm text-text outline-none focus-visible:border-accent sm:w-56"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Pasifleri göster
            </label>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setCreateOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              Yeni müşteri
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-panel/50 p-8 text-center text-sm text-muted">
            {customers.length === 0 ? "Henüz müşteri yok." : "Aramayla eşleşen müşteri yok."}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c) => {
              const lvl = c.deviceCount > 0 ? Math.min(1, c.onlineDevices / c.deviceCount) : 0;
              return (
                <article
                  key={c.id}
                  className={`glow-spill relative flex flex-col rounded-2xl border bg-panel p-4 transition-colors hover:border-glow/50 ${
                    c.isActive ? "border-border" : "border-border opacity-70"
                  }`}
                  style={{ "--lvl": lvl * 0.5, "--spread": "20px" } as React.CSSProperties}
                >
                  <Link
                    href={`/c/${c.slug}`}
                    className="absolute inset-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    aria-label={`${c.name} panelini aç`}
                  />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate font-display text-base font-semibold text-text">{c.name}</h2>
                      <p className="truncate font-mono text-[11px] text-muted">/c/{c.slug}</p>
                    </div>
                    {!c.isActive ? (
                      <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">pasif</span>
                    ) : c.summary.faultyLamps > 0 ? (
                      <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                        arıza · {c.summary.faultyLamps}
                      </span>
                    ) : null}
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div>
                      <dt className="text-muted">Bölge</dt>
                      <dd className="font-mono tabular-nums text-text">{formatInt(c.zoneCount)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Cihaz · çevrimiçi</dt>
                      <dd className="font-mono tabular-nums text-text">
                        {formatInt(c.deviceCount)} · <span className="text-accent">{formatInt(c.onlineDevices)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Ölçülen güç</dt>
                      <dd className="font-mono tabular-nums text-text">{formatPower(c.summary.powerW)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Kullanıcı</dt>
                      <dd className="font-mono tabular-nums text-text">{formatInt(c.userCount)}</dd>
                    </div>
                  </dl>

                  <div className="relative z-10 mt-4 flex items-center justify-between border-t border-border pt-3 text-xs">
                    <span className="truncate text-muted">{c.contactName ?? "İletişim kişisi yok"}</span>
                    <Link
                      href={`/admin/customers/${c.slug}`}
                      className="shrink-0 rounded-md px-2 py-1 font-medium text-muted transition-colors hover:bg-glow/10 hover:text-text"
                    >
                      Ayarlar ve kullanıcılar
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Global komut — tüm müşteriler (Meven:all/cmd) */}
      <section aria-label="Global komut" className="rounded-2xl border border-danger/30 bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-text">Tüm müşteriler — acil durum komutu</h2>
            <p className="mt-1 max-w-xl text-xs text-muted">
              Bu komut <code className="font-mono">Meven:all/cmd</code>&apos;ye gider ve{" "}
              <span className="font-semibold text-text">bütün müşterilerin bütün lambalarını</span> etkiler.
              Tek bir müşterinin sistemi için o müşterinin panelindeki &quot;Tüm Sistem&quot;i kullanın.
            </p>
          </div>
          <div className="flex gap-2">
            {GLOBAL_CMDS.map((cmd) => (
              <button
                key={cmd.label}
                type="button"
                onClick={() => {
                  setGlobalResult(null);
                  setGlobalConfirm(false);
                  setGlobalCmd(cmd);
                }}
                className="rounded-lg border border-danger/40 px-3 py-1.5 text-sm font-semibold text-danger transition-colors hover:bg-danger/10"
              >
                {cmd.label}
              </button>
            ))}
          </div>
        </div>
        {globalResult ? <p className="mt-3 text-xs text-text">{globalResult}</p> : null}
      </section>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Yeni müşteri">
        {error ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <CustomerForm submitting={submitting} onSubmit={createCustomer} onCancel={() => setCreateOpen(false)} />
      </Modal>

      <Modal open={globalCmd !== null} onClose={() => setGlobalCmd(null)} title="Tüm müşterilere komut">
        <p className="text-sm text-muted">
          <span className="font-semibold text-text">“{globalCmd?.label}”</span> komutu{" "}
          <span className="font-semibold text-text">{formatInt(customers.length)} müşterinin</span>{" "}
          {formatInt(totals.devices)} cihazına aynı anda gönderilecek.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm text-text">
          <input type="checkbox" className="mt-0.5" checked={globalConfirm} onChange={(e) => setGlobalConfirm(e.target.checked)} />
          Bunun tüm müşterilerin aydınlatmasını etkileyeceğini anlıyorum.
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setGlobalCmd(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
            İptal
          </button>
          <button
            type="button"
            onClick={sendGlobal}
            disabled={!globalConfirm || submitting}
            className="rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
          >
            {submitting ? "Gönderiliyor…" : "Gönder"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
