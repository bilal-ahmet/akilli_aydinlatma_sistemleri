"use client";

import { useCallback, useEffect, useState } from "react";
import type { DeviceView, ScheduleView, Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { useReconcile } from "@/app/_lib/useReconcile";
import { effectByNumber } from "@/lib/effects";
import { describeSchedule, formatRunAt, specOf } from "@/lib/scheduleTime";
import { ConfirmDelete, useDialogs } from "../PanelDialogs";
import { EmptyBox, PageHeader, PlusIcon } from "../PanelUi";
import { ClockIcon } from "../ScheduleForm";
import { Toggle } from "../Toggle";

/** "Aç %60", "Kapat", "Efekt: Dalga", "Efekti durdur". */
function actionText(s: ScheduleView): string {
  switch (s.action) {
    case "on":
      return s.value != null ? `Aç %${s.value}` : "Aç";
    case "off":
      return "Kapat";
    case "dim":
      return `Şiddet %${s.value ?? 0}`;
    case "stop_fx":
      return "Efekti durdur";
    default: {
      const label = effectByNumber(s.effectNumber)?.label ?? "Efekt";
      return `Efekt: ${label}${s.effectText ? ` “${s.effectText}”` : ""}`;
    }
  }
}

/** "Tüm bölgeler", "Park Yolu, Sahil", "Park Yolu ve 3 cihaz", "2 lamba". */
function targetText(s: ScheduleView, zones: Zone[], devices: DeviceView[]): string {
  const t = s.target;
  if ("all" in t) return "Tüm bölgeler";
  const names = t.zones.map((id) => zones.find((z) => z.id === id)?.name ?? "silinmiş bölge");
  const parts: string[] = [];
  if (names.length > 0 && names.length <= 2) parts.push(names.join(", "));
  else if (names.length > 2) parts.push(`${names.length} bölge`);
  const devCount = t.devices.length;
  const lampCount = t.lamps.length;
  if (devCount) parts.push(`${devCount} cihaz`);
  if (lampCount) parts.push(`${lampCount} lamba`);
  // Tek cihaz hedefinde cihaz adı daha anlaşılır.
  if (!names.length && devCount === 1 && !lampCount) {
    const d = devices.find((x) => x.deviceId === t.devices[0]);
    if (d?.name) return d.name;
  }
  return parts.join(" ve ");
}

function resultText(s: ScheduleView): { text: string; tone: "ok" | "warn" | "bad" } | null {
  const r = s.lastResult;
  if (!r) return null;
  if (r.missed) return { text: "kaçırıldı (sistem o sırada kapalıydı)", tone: "warn" };
  if (r.error) return { text: r.error, tone: "bad" };
  if (r.sent === 0) return { text: "gönderilecek hedef bulunamadı", tone: "warn" };
  return {
    text: r.skipped ? `gönderildi · ${r.skipped} hedef atlandı` : "gönderildi",
    tone: r.skipped ? "warn" : "ok",
  };
}

const TONE = { ok: "text-ok", warn: "text-warn", bad: "text-danger" } as const;

/** Tek seferlik ve zamanı geçmiş: "Tamamlandı". */
const done = (s: ScheduleView) => s.repeat === "once" && s.enabled && !s.nextRunAt;

function Row({
s,
canWrite,
busy,
when,
target,
onToggle,
onEdit,
onDelete,
}: {
s: ScheduleView;
canWrite: boolean;
busy: boolean;
when: (iso: string) => string;
target: string;
onToggle: (enabled: boolean) => void;
onEdit: () => void;
onDelete: () => void;
}) {
  const result = resultText(s);
  const finishedRow = done(s);
  return (
    <li
      className={`flex flex-wrap items-center gap-x-5 gap-y-3 px-[22px] py-4 ${
        finishedRow || !s.enabled ? "opacity-60" : ""
      }`}
    >
      {canWrite && !finishedRow ? (
        <Toggle
          checked={s.enabled}
          disabled={busy}
          onChange={onToggle}
          label={s.enabled ? "Zamanlamayı duraklat" : "Zamanlamayı etkinleştir"}
        />
      ) : (
        <span className="grid h-5 w-9 place-items-center text-muted">
          <ClockIcon size={16} />
        </span>
      )}

      <div className="flex min-w-[220px] flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold text-text">{s.name || actionText(s)}</span>
          {s.name ? (
            <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px] text-ink-2">{actionText(s)}</span>
          ) : null}
          {!s.enabled ? (
            <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px] text-muted">Duraklatıldı</span>
          ) : null}
          {finishedRow ? (
            <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px] text-muted">Tamamlandı</span>
          ) : null}
        </div>
        <span className="text-[13px] text-muted">
          {describeSchedule(specOf(s))} · {target}
        </span>
      </div>

      <div className="flex min-w-[180px] flex-col gap-0.5 text-[13px] sm:items-end sm:text-right">
        {s.enabled && s.nextRunAt ? (
          <span className="text-ink-2">
            Sonraki: <span className="font-medium text-text">{when(s.nextRunAt)}</span>
          </span>
        ) : null}
        {s.lastRunAt ? (
          <span className="text-muted">
            Son: {when(s.lastRunAt)}
            {result ? <span className={TONE[result.tone]}> · {result.text}</span> : null}
          </span>
        ) : (
          <span className="text-muted">Henüz çalışmadı</span>
        )}
      </div>

      {canWrite ? (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onEdit}
            className="btn-line h-9 cursor-pointer px-3.5 text-[13px]"
          >
            Düzenle
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Zamanlamayı sil"
            title="Sil"
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-[10px] text-muted transition-colors hover:bg-danger-soft hover:text-danger"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Zamanlamalar: seçilen saatte (sabit ya da gün batımı/doğumu) bölgelere,
 * cihazlara ya da lambalara otomatik komut. Çalıştıran sunucudur; sayfa
 * yalnızca listeler ve düzenler. Liste bu sayfaya özeldir.
 */
export function SchedulesView() {
  const api = useApi();
  const { canWrite } = usePanel();
  const { zones, devices } = useLighting();
  const { openSchedule } = useDialogs();
  const now = useNow(30_000);
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(api("/api/schedules"))
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j?.data)) {
          setSchedules(j.data as ScheduleView[]);
          setLoadError(null);
        } else {
          setLoadError(j?.error ?? "Zamanlamalar okunamadı");
        }
      })
      .catch(() => setLoadError("Zamanlamalar okunamadı"))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);
  useReconcile(load, 60_000);

  const upsert = (s: ScheduleView) =>
    setSchedules((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]));

  async function setEnabled(s: ScheduleView, enabled: boolean) {
    setBusy(s.id);
    setSchedules((list) => list.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    try {
      const res = await fetch(api(`/api/schedules/${s.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? "Güncellenemedi");
      upsert(j.data as ScheduleView);
      setLoadError(null);
    } catch (err) {
      setSchedules((list) => list.map((x) => (x.id === s.id ? s : x)));
      setLoadError(err instanceof Error ? err.message : "Güncellenemedi");
    } finally {
      setBusy(null);
    }
  }

    const sorted = [...schedules].sort((a, b) => {
    const ta = a.enabled && a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
    const tb = b.enabled && b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
    return ta - tb;
  });
  const active = sorted.filter((s) => !done(s));
  const finished = sorted.filter(done);
  const enabledCount = active.filter((s) => s.enabled).length;

  const nowDate = now === null ? null : new Date(now);
  const when = (iso: string) => (nowDate ? formatRunAt(new Date(iso), nowDate) : "");
  const rowProps = (s: ScheduleView) => ({
    canWrite,
    busy: busy === s.id,
    when,
    target: targetText(s, zones, devices),
    onToggle: (v: boolean) => void setEnabled(s, v),
    onEdit: () => openSchedule({ schedule: s, onSaved: upsert }),
    onDelete: () => setDeleting(s),
  });

  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        title="Zamanlamalar"
        subtitle={
          schedules.length === 0
            ? "Lambaları seçtiğiniz saatte kendiliğinden açın, kapatın ya da efekt başlatın."
            : `${schedules.length} zamanlama · ${enabledCount} etkin`
        }
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={() => openSchedule({ onSaved: upsert })}
              disabled={zones.length === 0}
              className="btn-glow h-10 cursor-pointer px-4 text-sm"
            >
              <PlusIcon />
              Yeni zamanlama
            </button>
          ) : null
        }
      />

      {loadError ? (
        <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{loadError}</p>
      ) : null}

      {loading ? null : schedules.length === 0 ? (
        <EmptyBox>
          {zones.length === 0
            ? "Zamanlama kurmak için önce bir bölge oluşturun."
            : "Henüz zamanlama yok. Örneğin her gün gün batımında açılıp gece yarısı kısılmasını ayarlayabilirsiniz."}
        </EmptyBox>
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-panel">
              {active.map((s) => (
                <Row key={s.id} s={s} {...rowProps(s)} />
              ))}
            </ul>
          ) : null}
          {finished.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="eyebrow">Tamamlananlar</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-panel">
                {finished.map((s) => (
                  <Row key={s.id} s={s} {...rowProps(s)} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <p className="text-[12.5px] leading-snug text-muted">
        Saatler Türkiye saatidir. Gün batımı ve gün doğumu her gün Kocaeli için yeniden hesaplanır.
        Zamanlamalar sunucuda çalışır; bu sayfanın açık olması gerekmez.
      </p>

      {deleting ? (
        <ConfirmDelete
          title="Zamanlamayı sil"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const res = await fetch(api(`/api/schedules/${deleting.id}`), { method: "DELETE" });
            if (!res.ok) {
              const j = await res.json().catch(() => null);
              throw new Error(j?.error ?? "Silinemedi");
            }
            setSchedules((list) => list.filter((x) => x.id !== deleting.id));
          }}
        >
          <p>
            <span className="font-semibold text-text">{deleting.name || actionText(deleting)}</span> (
            {describeSchedule(specOf(deleting))}) silinecek. Bundan sonra çalışmaz.
          </p>
        </ConfirmDelete>
      ) : null}
    </div>
  );
}
