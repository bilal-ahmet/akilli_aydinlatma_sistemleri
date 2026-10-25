"use client";

import Link from "next/link";
import type { DeviceView, FaultRecord } from "@/app/_lib/types";
import type { AlertItem } from "@/app/_lib/alerts";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel, useTechnical } from "@/app/_lib/panel";
import { deviceName, formatDuration } from "@/app/_lib/format";
import { formatMac } from "@/lib/mac";
import {
  faultCategory,
  faultCategoryLabel,
  faultDescription,
  faultLabel,
  isWarningCode,
  type FaultCategory,
} from "@/lib/faults";
import { useDialogs } from "./PanelDialogs";

/**
 * Arıza kayıtlarının ortak görünümü — Arızalar sayfası ve bölge detayı aynı
 * kartları kullanır. Her kayıtta: tür (arıza/uyarı/komut) + parça kategorisi,
 * başlık, ne olduğu ve etiketli konum (bölge · cihaz · lamba).
 */

/** "26 Eylül, 22:14" */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
  const time = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  return `${date}, ${time}`;
}

function Badge({ tone, children }: { tone: "bad" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-[24px] shrink-0 items-center justify-center rounded-md px-2.5 text-[12px] font-semibold ${
        tone === "bad" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"
      }`}
    >
      {children}
    </span>
  );
}

function CategoryChip({ category }: { category: FaultCategory }) {
  const technical = useTechnical();
  return (
    <span className="inline-flex h-[24px] shrink-0 items-center rounded-md border border-border px-2 text-[12px] font-medium text-ink-2">
      {faultCategoryLabel(category, technical)}
    </span>
  );
}

function lampLabel(device: DeviceView | undefined, channel: number, technical: boolean): string {
  const name = device?.lamps.find((l) => l.channel === channel)?.name?.trim();
  const base = name || `Lamba ${channel}`;
  return technical ? `${base} · ch${channel}` : base;
}

/** Etiketli konum satırı: Bölge · Cihaz · Lamba. */
function Location({
  zoneSlug,
  zoneName,
  deviceId,
  deviceName: name,
  channel,
  showZone,
}: {
  zoneSlug: string | null;
  zoneName: string | null;
  deviceId: string;
  deviceName: string | null;
  channel: number | null;
  showZone: boolean;
}) {
  const technical = useTechnical();
  const { customerSlug } = usePanel();
  const { devices } = useLighting();
  const device = devices.find((d) => d.deviceId === deviceId);

  const items: Array<{ label: string; value: React.ReactNode }> = [];
  if (showZone && zoneName) {
    items.push({
      label: "Bölge",
      value: zoneSlug ? (
        <Link href={`/c/${customerSlug}/bolgeler/${zoneSlug}`} className="hover:text-accent hover:underline">
          {zoneName}
        </Link>
      ) : (
        zoneName
      ),
    });
  }
  items.push({
    label: "Cihaz",
    value: (
      <>
        {deviceName({ name: device?.name ?? name, deviceId }, technical)}
        {technical && (device?.name ?? name) ? (
          <span className="ml-1.5 font-mono text-[11.5px] text-muted">{formatMac(deviceId)}</span>
        ) : null}
      </>
    ),
  });
  items.push({
    label: "Lamba",
    value: channel !== null ? lampLabel(device, channel, technical) : "Cihazın tamamı",
  });

  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 items-baseline gap-1.5">
          <dt className="text-muted">{it.label}:</dt>
          <dd className="min-w-0 font-medium text-text">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Bugün başladıysa yalnızca saat, değilse tarih + saat. */
function formatStart(iso: string, now: number | null): string {
  const d = new Date(iso);
  const today = now !== null && new Date(now).toDateString() === d.toDateString();
  return today
    ? `Bugün ${d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}`
    : formatWhen(iso);
}

/** Süren sorun kartı (lamba arızası ya da komut hatası). */
export function OpenAlertCard({
  alert,
  now,
  showZone = true,
}: {
  alert: AlertItem;
  now: number | null;
  showZone?: boolean;
}) {
  const technical = useTechnical();
  const { devices, poles } = useLighting();
  const { customerSlug } = usePanel();
  const { openDevice } = useDialogs();
  const device = devices.find((d) => d.deviceId === alert.deviceId);
  const pole = device?.poleId ? poles.find((p) => p.id === device.poleId && p.lat !== null) : undefined;
  const kindLabel =
    alert.kind === "command" ? (technical ? "Komut hatası" : "Komut uygulanamadı") : alert.warning ? "Uyarı" : "Arıza";

  return (
    <div
      className={`flex flex-col gap-3 rounded-[14px] border bg-panel px-5 py-4 sm:px-[22px] ${
        alert.warning ? "border-border" : "border-danger/30"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={alert.warning ? "warn" : "bad"}>{kindLabel}</Badge>
        <CategoryChip category={alert.category} />
        <p className="min-w-0 flex-1 text-[15px] font-semibold text-text">{alert.title}</p>
        {pole ? (
          <Link
            href={`/c/${customerSlug}/harita?direk=${pole.id}`}
            className="btn-line h-[32px] px-3 text-[13px]"
          >
            Haritada göster
          </Link>
        ) : null}
        {device ? (
          <button type="button" onClick={() => openDevice(device)} className="btn-line h-[32px] px-3 text-[13px]">
            Cihaza git
          </button>
        ) : null}
      </div>

      {alert.cause ? <p className="text-[13.5px] text-ink-2">{alert.cause}</p> : null}

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <Location {...alert} showZone={showZone} />
        {alert.since ? (
          <p className="text-[12.5px] text-muted">
            Başladı: {formatStart(alert.since, now)}
            {now !== null ? (
              <>
                {" · "}
                <span className={alert.warning ? "text-accent" : "text-danger"}>
                  {formatDuration(now - new Date(alert.since).getTime())} sürüyor
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Çözülmüş arıza satırları (geçmiş). */
export function ResolvedFaultRows({
  records,
  showZone = true,
}: {
  records: FaultRecord[];
  showZone?: boolean;
}) {
  const technical = useTechnical();
  return (
    <>
      {records.map((h) => {
        const warn = isWarningCode(h.code);
        const text = faultDescription(h.code, technical);
        const duration = new Date(h.resolvedAt!).getTime() - new Date(h.startedAt).getTime();
        return (
          <div
            key={h.id}
            className="flex flex-col gap-2 border-b border-border px-5 py-4 last:border-b-0 sm:px-[22px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={warn ? "warn" : "bad"}>{warn ? "Uyarı" : "Arıza"}</Badge>
              <CategoryChip category={faultCategory(h.code)} />
              <p className="min-w-0 flex-1 text-[14.5px] font-semibold text-text">{faultLabel(h.code, technical)}</p>
              <span className="text-[12.5px] font-medium text-ok">Çözüldü</span>
            </div>
            {text ? <p className="text-[13px] text-ink-2">{text.what}</p> : null}
            <Location {...h} showZone={showZone} />
            <p className="text-[12.5px] text-muted">
              {formatWhen(h.startedAt)} → {formatWhen(h.resolvedAt!)} · {formatDuration(duration)} sürdü
            </p>
          </div>
        );
      })}
    </>
  );
}
