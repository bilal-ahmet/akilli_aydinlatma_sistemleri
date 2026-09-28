"use client";

import { useEffect, useState } from "react";
import type { FaultRecord } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useApi } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { openAlerts, type AlertItem } from "@/app/_lib/alerts";
import { formatDuration } from "@/app/_lib/format";
import { faultLabel } from "@/lib/faults";
import { formatMac } from "@/lib/mac";
import { useDialogs } from "../PanelDialogs";
import { PageHeader } from "../PanelUi";

const HISTORY_DAYS = 30;

/**
 * Sürücünün kendini koruduğu durumlar arıza değil uyarıdır: ışık hâlâ yanıyor
 * ama kısılmış (termal kısma, güç sınırlama).
 */
const WARNING_CODES = new Set(["driver.thermal_derating", "driver.power_limitation", "led.thermal_derating"]);

/** "26 Eylül, 22:14" */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  const time = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

/** Bugün başladıysa yalnızca saat, değilse tarih + saat. */
function formatSince(iso: string, now: number | null): string {
  const d = new Date(iso);
  const today = now !== null && new Date(now).toDateString() === d.toDateString();
  return today
    ? `${d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}'den beri`
    : `${formatWhen(iso)}'den beri`;
}

function where(parts: { deviceId: string; deviceName: string | null; zoneName: string | null; channel: number | null }) {
  return [
    parts.deviceName || formatMac(parts.deviceId),
    parts.zoneName,
    parts.channel !== null ? `Lamba ${parts.channel}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Badge({ tone, children }: { tone: "bad" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-[26px] shrink-0 items-center justify-center rounded-md px-2.5 text-[12.5px] font-semibold ${
        tone === "bad" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"
      }`}
    >
      {children}
    </span>
  );
}

function OpenAlert({ alert, now }: { alert: AlertItem; now: number | null }) {
  const { devices } = useLighting();
  const { openDevice } = useDialogs();
  const device = devices.find((d) => d.deviceId === alert.deviceId);
  const warn = alert.code !== null && WARNING_CODES.has(alert.code);

  return (
    <div className="grid items-center gap-4 rounded-[14px] border border-border bg-panel px-5 py-[18px] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-[18px] sm:px-[22px]">
      <Badge tone={warn ? "warn" : "bad"}>
        {alert.kind === "command" ? "Komut" : warn ? "Uyarı" : "Arıza"}
      </Badge>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <p className="text-[15px] font-semibold text-text">{alert.title}</p>
        {alert.cause ? <p className="text-[13px] text-ink-2">{alert.cause}</p> : null}
        <p className="text-[13px] text-muted">
          {where(alert)}
          {alert.since ? ` · ${formatSince(alert.since, now)}` : ""}
        </p>
      </div>
      {device ? (
        <button type="button" onClick={() => openDevice(device)} className="btn-line h-[34px] px-3.5 text-[13px]">
          Cihaza git
        </button>
      ) : null}
    </div>
  );
}

/**
 * Arızalar ve uyarılar: süren sorunlar (lamba arızaları + komut hataları) ve
 * son 30 günde çözülenler. Arızalar elle kapatılmaz — cihaz bir sonraki
 * raporunda bayrağı indirince (ya da başarılı komut yanıtıyla) kendiliğinden
 * çözülür ve geçmişe taşınır (bkz. lib/faultLog.ts).
 */
export function FaultsView() {
  const api = useApi();
  const { faults, devices } = useLighting();
  const alerts = openAlerts(faults, devices);
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

  const resolved = (history ?? []).filter((h) => h.resolvedAt !== null);

  return (
    <div className="flex max-w-[1100px] flex-col gap-6">
      <PageHeader
        title="Arızalar ve uyarılar"
        subtitle="Cihazlardan gelen sorunlar burada listelenir. Cihaz sorunun geçtiğini bildirince kayıt geçmişe taşınır."
      />

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Açık · {alerts.length}</h2>
        {alerts.length > 0 ? (
          alerts.map((a) => <OpenAlert key={a.key} alert={a} now={now} />)
        ) : (
          <div className="flex flex-col items-center gap-2.5 rounded-[14px] border border-border bg-panel px-[22px] py-9 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft" aria-hidden>
              <span className="h-3.5 w-3.5 rounded-full bg-ok" />
            </span>
            <p className="text-base font-semibold text-text">Açık arıza yok</p>
            <p className="text-sm text-muted">
              {devices.length > 0
                ? `${devices.length} cihazın tamamı normal çalışıyor.`
                : "Henüz cihaz tanımlanmadı."}
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Geçmiş · son {HISTORY_DAYS} gün</h2>
        <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
          {history === null ? (
            <p className="px-[22px] py-5 text-sm text-muted">Yükleniyor…</p>
          ) : resolved.length === 0 ? (
            <p className="px-[22px] py-5 text-sm text-muted">Son {HISTORY_DAYS} günde çözülmüş arıza yok.</p>
          ) : (
            resolved.map((h) => {
              const warn = WARNING_CODES.has(h.code);
              const duration = new Date(h.resolvedAt!).getTime() - new Date(h.startedAt).getTime();
              return (
                <div
                  key={h.id}
                  className="grid items-center gap-x-[18px] gap-y-1.5 border-b border-border px-5 py-4 last:border-b-0 sm:grid-cols-[80px_minmax(0,1fr)_170px_140px] sm:px-[22px]"
                >
                  <span className="justify-self-start sm:justify-self-stretch">
                    <Badge tone={warn ? "warn" : "bad"}>{warn ? "Uyarı" : "Arıza"}</Badge>
                  </span>
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <p className="text-[14.5px] font-semibold text-text">{faultLabel(h.code)}</p>
                    <p className="text-[13px] text-muted">{where(h)}</p>
                  </div>
                  <p className="text-[13px] text-ink-2">{formatWhen(h.startedAt)}</p>
                  <p className="text-[13px] text-ok">Çözüldü · {formatDuration(duration)}</p>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
