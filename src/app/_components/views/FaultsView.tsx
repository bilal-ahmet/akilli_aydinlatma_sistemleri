"use client";

import { useEffect, useState } from "react";
import type { FaultRecord } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, useTechnical } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { openAlerts } from "@/app/_lib/alerts";
import { OpenAlertCard, ResolvedFaultRows } from "../FaultItems";
import { PageHeader } from "../PanelUi";

const HISTORY_DAYS = 30;

/** Sayfanın üstündeki özet: kaç arıza, kaç uyarı, kaç komut hatası, kaç lamba. */
function Counts({ items }: { items: Array<{ label: string; value: number; tone: string }> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-baseline gap-1.5 rounded-lg border border-border bg-panel px-3 py-1.5 text-[13px] text-muted"
        >
          <span className={`text-[15px] font-semibold tabular-nums ${it.value > 0 ? it.tone : "text-muted"}`}>
            {it.value}
          </span>
          {it.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Arızalar ve uyarılar: süren sorunlar (lamba arızaları + komut hataları) ve
 * son 30 günde çözülenler. Arızalar elle kapatılmaz — cihaz bir sonraki
 * raporunda bayrağı indirince (ya da başarılı komut yanıtıyla) kendiliğinden
 * çözülür ve geçmişe taşınır (bkz. lib/faultLog.ts).
 */
export function FaultsView({ initialZone = "" }: { initialZone?: string }) {
  const api = useApi();
  const { faults, devices, zones } = useLighting();
  const technical = useTechnical();
  const [zoneFilter, setZoneFilter] = useState(initialZone);
  const alerts = openAlerts(faults, devices, technical).filter(
    (a) => !zoneFilter || a.zoneSlug === zoneFilter,
  );
  const [history, setHistory] = useState<FaultRecord[] | null>(null);
  const now = useNow(60_000);

  // Süren arıza kümesi değişince (biri çözüldü / yenisi geldi) geçmişi tazele.
  const openKey = faults.map((f) => `${f.deviceId}:${f.channel}:${f.code}`).join("|");
  useEffect(() => {
    let cancelled = false;
    fetch(api(`/api/faults?days=${HISTORY_DAYS}`))
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && Array.isArray(j.data)) setHistory(j.data as FaultRecord[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, openKey]);

  const resolved = (history ?? []).filter(
    (h) => h.resolvedAt !== null && (!zoneFilter || h.zoneSlug === zoneFilter),
  );
  const faultCount = alerts.filter((a) => a.kind === "fault" && !a.warning).length;
  const warnCount = alerts.filter((a) => a.warning).length;
  const commandCount = alerts.filter((a) => a.kind === "command").length;
  const lampCount = new Set(
    alerts.filter((a) => a.channel !== null).map((a) => `${a.deviceId}:${a.channel}`),
  ).size;
  const zoneName = zones.find((z) => z.id === zoneFilter)?.name;

  return (
    <div className="flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Arızalar ve uyarılar"
        subtitle="Cihazlardan gelen sorunlar burada listelenir. Cihaz sorunun geçtiğini bildirince kayıt kendiliğinden geçmişe taşınır."
        actions={
          zones.length > 1 || zoneFilter ? (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Bölge
              <select
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value)}
                className="field !h-9 !w-auto !py-0 !text-[13.5px]"
              >
                <option value="">Tüm bölgeler</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null
        }
      />

      <Counts
        items={[
          { label: "arıza", value: faultCount, tone: "text-danger" },
          { label: "uyarı", value: warnCount, tone: "text-accent" },
          {
            label: technical ? "komut hatası" : "uygulanamayan komut",
            value: commandCount,
            tone: "text-danger",
          },
          { label: "etkilenen lamba", value: lampCount, tone: "text-text" },
        ]}
      />

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Süren · {alerts.length}</h2>
        {alerts.length > 0 ? (
          alerts.map((a) => <OpenAlertCard key={a.key} alert={a} now={now} showZone={!zoneFilter} />)
        ) : (
          <div className="flex flex-col items-center gap-2.5 rounded-[14px] border border-border bg-panel px-[22px] py-9 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft" aria-hidden>
              <span className="h-3.5 w-3.5 rounded-full bg-ok" />
            </span>
            <p className="text-base font-semibold text-text">Açık arıza yok</p>
            <p className="text-sm text-muted">
              {zoneName
                ? `${zoneName} bölgesindeki cihazlar normal çalışıyor.`
                : devices.length > 0
                  ? `${devices.length} cihazın tamamı normal çalışıyor.`
                  : "Henüz cihaz tanımlanmadı."}
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">
          Çözülenler · son {HISTORY_DAYS} gün{history ? ` · ${resolved.length}` : ""}
        </h2>
        <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
          {history === null ? (
            <p className="px-[22px] py-5 text-sm text-muted">Yükleniyor…</p>
          ) : resolved.length === 0 ? (
            <p className="px-[22px] py-5 text-sm text-muted">Son {HISTORY_DAYS} günde çözülmüş arıza yok.</p>
          ) : (
            <ResolvedFaultRows records={resolved} showZone={!zoneFilter} />
          )}
        </div>
      </section>
    </div>
  );
}
