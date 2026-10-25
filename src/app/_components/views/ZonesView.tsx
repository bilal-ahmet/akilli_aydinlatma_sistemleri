"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DeviceView, FaultRecord, Zone } from "@/app/_lib/types";
import { isLit } from "@/app/_lib/mockData";
import { useLighting } from "@/app/_lib/lighting";
import { useApi, usePanel, useTechnical } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { useZoneStats } from "@/app/_lib/useZoneStats";
import { isOnline, splitPower, zoneMeta } from "@/app/_lib/deviceHealth";
import { openAlerts } from "@/app/_lib/alerts";
import { effectByNumber } from "@/lib/effects";
import { formatInt } from "@/app/_lib/format";
import { emptySelection, lampOn, pruneSelection, type Selection } from "@/app/_lib/selection";
import { OpenAlertCard, ResolvedFaultRows } from "../FaultItems";
import { Toggle } from "../Toggle";
import { BrightnessSlider } from "../BrightnessSlider";
import { useDialogs } from "../PanelDialogs";
import { EmptyBox, PageHeader, PlusIcon, StatCard } from "../PanelUi";
import { SelectionQuickBar } from "../SelectionQuickBar";
import { SelectionActionBar } from "../SelectionActionBar";
import { DeviceTable } from "./DeviceTable";

const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

const HISTORY_DAYS = 30;
/** Bölge geçmişinde ilk açılışta gösterilen kayıt sayısı. */
const HISTORY_PREVIEW = 5;

/** Cihazlara kayıtlı lamba (DALI kanalı) toplamı. */
function lampTotal(devices: DeviceView[]): number {
  return devices.reduce((n, d) => n + Math.max(d.lampCount, d.lamps.length), 0);
}

/**
 * Envanter kutusu: "çalışan / toplam" + oran çubuğu + kısa açıklama. Çubuk
 * çalışmayan pay varsa dikkat rengine döner.
 */
function CountTile({
  label,
  active,
  total,
  hint,
  alert,
}: {
  label: string;
  active: number;
  total: number;
  hint: string;
  /** Sorun var (bağlantısız cihaz, arızalı lamba) — sayı ve alt satır kırmızı. */
  alert?: boolean;
}) {
  const pct = total > 0 ? Math.round((active / total) * 100) : 0;
  return (
    <div className="stat-card flex flex-col gap-2">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="flex items-baseline gap-1">
        <span className="text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums text-text">
          {formatInt(active)}
        </span>
        <span className="text-base text-muted">/ {formatInt(total)}</span>
      </p>
      <span className="h-1 overflow-hidden rounded-sm bg-track" aria-hidden>
        <span
          className={`block h-full transition-[width] duration-500 ${alert ? "bg-danger" : "bg-ok"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <p className={`text-[12.5px] ${alert ? "text-danger" : "text-muted"}`}>{hint}</p>
    </div>
  );
}

/** Bölge durum noktası: arıza > kapalı > açık. */
function zoneDot(zone: Zone, faulty: boolean): string {
  if (faulty || zone.status === "fault") return "bg-danger";
  if (zone.status === "warning") return "bg-warn";
  return isLit(zone) ? "bg-ok" : "bg-border-strong";
}

/** Soldaki bölge listesi (geniş ekran) / yatay şerit (dar ekran). */
function ZoneList({ selected }: { selected: string | null }) {
  const { zones, faultsByZone } = useLighting();
  const { customerSlug, canWrite } = usePanel();
  const { openZoneForm } = useDialogs();
  const router = useRouter();
  const stats = useZoneStats();

  return (
    <div className="flex min-w-0 flex-col gap-3.5 lg:sticky lg:top-7 lg:self-start">
      <div className="flex items-center justify-between gap-2 px-1 lg:px-2">
        <h1 className="text-xl font-bold tracking-tight text-text">Bölgeler</h1>
        {canWrite ? (
          <button
            type="button"
            onClick={() => openZoneForm(undefined, (z) => router.push(`/c/${customerSlug}/bolgeler/${z.id}`))}
            className="btn-glow h-8 px-3 text-[13px]"
          >
            <PlusIcon />
            Yeni Bölge
          </button>
        ) : null}
      </div>
      <nav
        aria-label="Bölge listesi"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      >
        {zones.map((z) => {
          const active = z.id === selected;
          const pct = z.isOn ? z.brightness : 0;
          const faulty = (faultsByZone.get(z.id)?.length ?? 0) > 0;
          return (
            <Link
              key={z.id}
              href={`/c/${customerSlug}/bolgeler/${z.id}`}
              aria-current={active ? "page" : undefined}
              className={`flex w-[240px] shrink-0 flex-col gap-2 rounded-xl border px-3 py-3.5 transition-colors lg:w-auto ${
                active
                  ? "border-border bg-panel shadow-[0_1px_2px_rgba(0,0,0,.04)]"
                  : "border-transparent hover:bg-panel/60"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-text">{z.name}</span>
                <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${zoneDot(z, faulty)}`} />
              </span>
              <span className="truncate text-[12.5px] text-muted">
                {zoneMeta(z, stats(z.id).devices.length, lampTotal(stats(z.id).devices))}
              </span>
              <span className="flex items-center gap-2.5">
                <span className="h-1 flex-1 overflow-hidden rounded-sm bg-track">
                  <span
                    className="block h-full bg-[linear-gradient(90deg,oklch(0.7_0.17_55),oklch(0.84_0.15_78))] shadow-[0_0_8px_oklch(0.77_0.16_68/.7)] transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-9 text-right font-mono text-xs text-ink-2">
                  {z.isOn ? `%${z.brightness}` : "—"}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function ZoneDetail({ zone }: { zone: Zone }) {
  const technical = useTechnical();
  const { toggleZone, setZoneBrightness, faults, devices: allDevices } = useLighting();
  const { customerSlug, canWrite } = usePanel();
  const { openZoneForm, confirmDeleteZone, openZoneEffects, openDeviceForm } = useDialogs();
  const router = useRouter();
  const api = useApi();
  const now = useNow(60_000);
  const { devices, measure } = useZoneStats()(zone.id);
  const effect = effectByNumber(zone.activeFx);
  // Toplu kontrol seçimi — bileşen bölge başına `key`'lendiği için bölge
  // değişince sıfırlanır. Silinen/taşınan cihazlar render'da ayıklanır.
  const [picked, setPicked] = useState<Selection>(emptySelection);
  const selection = pruneSelection(picked, devices);

  const power = measure.powerW !== null ? splitPower(measure.powerW) : null;
  const load = measure.loadPowerW !== null ? splitPower(measure.loadPowerW) : null;
  const noData = "Cihaz henüz bildirmedi";

  // Süren sorunlar (lamba arızası + komut hatası) — Arızalar sayfasıyla aynı liste.
  const alerts = openAlerts(faults, allDevices, technical).filter((a) => a.zoneSlug === zone.id);

  // Envanter: direk (bölge açıksa hepsi), bağlı cihaz, yanan lamba.
  const lit = isLit(zone);
  const lampsTotal = lampTotal(devices);
  const lampsLit = devices.reduce((n, d) => n + d.lamps.filter(lampOn).length, 0);
  const faultyLamps = new Set(
    alerts
      .filter((a) => a.kind === "fault" && !a.warning && a.channel !== null)
      .map((a) => `${a.deviceId}:${a.channel}`),
  ).size;
  const online = now === null ? 0 : devices.filter((d) => isOnline(d, now)).length;
  const offline = now === null ? 0 : devices.length - online;
  const lampHint =
    lampsTotal === 0
      ? "Kayıtlı lamba yok"
      : [faultyLamps > 0 ? `${faultyLamps} arızalı` : null, lampsTotal - lampsLit > 0 ? `${lampsTotal - lampsLit} kapalı` : null]
          .filter(Boolean)
          .join(" · ") || "Hepsi yanıyor";

  // Bölgenin arıza geçmişi (son 30 gün). Süren arıza kümesi değişince tazelenir;
  // bileşen bölge başına `key`'lendiği için bölge değişince sıfırlanır.
  const [history, setHistory] = useState<FaultRecord[] | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const openKey = alerts.map((a) => a.key).join("|");
  useEffect(() => {
    let cancelled = false;
    fetch(api(`/api/faults?days=${HISTORY_DAYS}&zone=${encodeURIComponent(zone.id)}`))
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && Array.isArray(j.data)) setHistory(j.data as FaultRecord[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, zone.id, openKey]);
  const resolved = (history ?? []).filter((h) => h.resolvedAt !== null);
  const shownHistory = showAllHistory ? resolved : resolved.slice(0, HISTORY_PREVIEW);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow={
          <>
            <Link href={`/c/${customerSlug}/bolgeler`} className="hover:text-text">
              Bölgeler
            </Link>{" "}
            / {zone.name}
          </>
        }
        title={zone.name}
        subtitle={zone.district ? <span className="text-ink-2">{zone.district}</span> : undefined}
        actions={
          canWrite ? (
            <>
              <button type="button" onClick={() => openZoneForm(zone)} className="btn-line h-9 px-3.5 text-[13.5px]">
                Düzenle
              </button>
              <button
                type="button"
                onClick={() => confirmDeleteZone(zone, () => router.push(`/c/${customerSlug}/bolgeler`))}
                className="btn-line h-9 px-3.5 text-[13.5px] !text-danger"
              >
                Sil
              </button>
            </>
          ) : null
        }
      />

      {/* Kontrol kartı: aç/kapa + efekt, şiddet, büyük yüzde */}
      <section
        aria-label="Bölge kontrolü"
        className="grid items-center gap-5 rounded-2xl border border-border bg-panel px-5 py-[22px] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-8 sm:px-[26px]"
      >
        <div className="flex items-center gap-3.5">
          <Toggle
            checked={zone.isOn}
            onChange={(on) => toggleZone(zone.id, on)}
            label={`${zone.name} aç/kapat`}
            size="lg"
            disabled={!canWrite}
          />
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-text">{isLit(zone) ? "Açık" : "Kapalı"}</span>
            {canWrite ? (
              <button
                type="button"
                onClick={() => openZoneEffects(zone)}
                className="text-left text-[12.5px] text-muted transition-colors hover:text-accent"
              >
                Efekt: {effect ? <span className="text-accent">{effect.label}</span> : "yok"} ›
              </button>
            ) : (
              <span className="text-[12.5px] text-muted">Efekt: {effect?.label ?? "yok"}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-[13px] text-ink-2">Bölge şiddeti</span>
          {/* Kapalıyken bar 0; açılınca son parlaklık (zone.brightness) geri gelir. */}
          <BrightnessSlider
            value={zone.isOn ? zone.brightness : 0}
            onChange={(v) => setZoneBrightness(zone.id, v)}
            label={`${zone.name} ışık şiddeti`}
            size="lg"
            hideValue
            disabled={!canWrite}
          />
        </div>
        <span className="font-mono text-[30px] font-semibold tracking-[-0.03em] text-accent">
          %{zone.isOn ? zone.brightness : 0}
        </span>
      </section>

      <section aria-label="Bölge envanteri" className="grid gap-4 sm:grid-cols-3">
        <CountTile
          label="Aktif direk"
          active={lit ? zone.poleCount : 0}
          total={zone.poleCount}
          hint={
            zone.poleCount === 0
              ? canWrite
                ? "Direk sayısı girilmemiş — “Düzenle”den ekleyin"
                : "Direk sayısı girilmemiş"
              : lit
                ? "Bölge açık, direklerin hepsi yanıyor"
                : "Bölge kapalı"
          }
        />
        <CountTile
          label="Bağlı cihaz"
          active={online}
          total={devices.length}
          alert={offline > 0}
          hint={
            devices.length === 0
              ? "Bölgede cihaz yok"
              : now === null
                ? "…"
                : offline > 0
                  ? `${offline} cihaz son 3 dakikadır haber vermiyor`
                  : "Hepsi bağlı"
          }
        />
        <CountTile
          label="Yanan lamba"
          active={lampsLit}
          total={lampsTotal}
          alert={faultyLamps > 0}
          hint={lampHint}
        />
      </section>

      <section aria-label="Arıza durumu" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="eyebrow">Süren arızalar · {alerts.length}</h2>
          <Link href={`/c/${customerSlug}/arizalar?bolge=${encodeURIComponent(zone.id)}`} className="text-[13px] font-medium text-accent hover:underline">
            Arızalar sayfasında aç ›
          </Link>
        </div>
        {alerts.length > 0 ? (
          alerts.map((a) => <OpenAlertCard key={a.key} alert={a} now={now} showZone={false} />)
        ) : (
          <p className="flex items-center gap-2.5 rounded-[14px] border border-border bg-panel px-5 py-4 text-sm text-ink-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-ok" />
            Bu bölgede şu an süren arıza yok.
          </p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Çekilen güç"
          value={power?.value ?? "—"}
          unit={power?.unit}
          hint={power ? `${measure.lamps} lambadan ölçüldü` : noData}
        />
        <StatCard
          label="LED gerilimi (ort.)"
          value={
            measure.ledVoltageV !== null
              ? `${measure.ledVoltageEstimated ? "≈" : ""}${tr1.format(measure.ledVoltageV)}`
              : "—"
          }
          unit={measure.ledVoltageV !== null ? "V" : undefined}
          hint={
            measure.ledVoltageV !== null
              ? `${measure.ledVoltageLamps} lamba ortalaması${measure.ledVoltageEstimated ? " (tahmini)" : ""}`
              : noData
          }
        />
        <StatCard
          label={technical ? "Yük gücü" : "Lamba gücü"}
          value={load?.value ?? "—"}
          unit={load?.unit}
          hint={load ? "LED'e giden güç" : noData}
        />
      </div>

      <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-panel">
        <div className="flex items-center justify-between gap-2 px-[22px] py-[18px]">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-base font-semibold text-text">Bu bölgedeki cihazlar</h2>
            {canWrite && devices.length > 1 ? (
              <p className="text-[12.5px] text-muted">
                Cihazları işaretleyip birlikte açıp kapatabilir, şiddet ya da efekt uygulayabilirsiniz.
              </p>
            ) : null}
          </div>
          {canWrite ? (
            <button
              type="button"
              onClick={() => openDeviceForm({ zoneSlug: zone.id })}
              className="text-[13px] font-medium text-accent hover:underline"
            >
              + Cihaz ekle
            </button>
          ) : null}
        </div>
        {devices.length === 0 ? (
          <p className="border-t border-border px-[22px] py-6 text-sm text-muted">
            Bu bölgede tanımlı cihaz yok.
            {canWrite ? " “+ Cihaz ekle” ile bu bölgeye bir cihaz bağlayabilirsiniz." : ""}
          </p>
        ) : (
          <>
            {canWrite ? (
              <div className="border-t border-border px-[22px] py-3">
                <SelectionQuickBar devices={devices} selection={selection} onChange={setPicked} />
              </div>
            ) : null}
            <DeviceTable
              devices={devices}
              showLevel
              selection={canWrite ? selection : undefined}
              onSelectionChange={setPicked}
            />
          </>
        )}
      </section>

      <section aria-label="Arıza geçmişi" className="flex flex-col gap-3">
        <h2 className="eyebrow">
          Geçmiş arızalar · son {HISTORY_DAYS} gün{history ? ` · ${resolved.length}` : ""}
        </h2>
        <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
          {history === null ? (
            <p className="px-[22px] py-5 text-sm text-muted">Yükleniyor…</p>
          ) : resolved.length === 0 ? (
            <p className="px-[22px] py-5 text-sm text-muted">
              Bu bölgede son {HISTORY_DAYS} günde çözülmüş arıza yok.
            </p>
          ) : (
            <>
              <ResolvedFaultRows records={shownHistory} showZone={false} />
              {resolved.length > HISTORY_PREVIEW ? (
                <button
                  type="button"
                  onClick={() => setShowAllHistory((v) => !v)}
                  className="w-full border-t border-border px-[22px] py-3 text-left text-[13px] font-medium text-accent hover:underline"
                >
                  {showAllHistory ? "Daha az göster" : `Tümünü göster (${resolved.length})`}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      <SelectionActionBar
        devices={devices}
        selection={selection}
        onClear={() => setPicked(emptySelection())}
      />
    </div>
  );
}

/**
 * Bölgeler sayfası: solda bölge listesi, sağda seçili bölgenin detayı
 * (kontrol, ölçüm, arıza, cihazlar). Slug verilmezse ya da bulunamazsa
 * (silinmiş/taşınmış) ilk bölge gösterilir.
 */
export function ZonesView({ zoneSlug }: { zoneSlug: string | null }) {
  const { zones } = useLighting();
  const { canWrite } = usePanel();
  const { openZoneForm } = useDialogs();
  const zone = zones.find((z) => z.id === zoneSlug) ?? zones[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[268px_minmax(0,1fr)] lg:gap-8">
      <ZoneList selected={zone?.id ?? null} />
      {zone ? (
        <ZoneDetail key={zone.id} zone={zone} />
      ) : (
        <EmptyBox>
          Henüz bölge yok.
          {canWrite ? (
            <>
              {" "}
              <button type="button" onClick={() => openZoneForm()} className="font-medium text-accent hover:underline">
                İlk bölgeyi oluşturun
              </button>
              .
            </>
          ) : null}
        </EmptyBox>
      )}
    </div>
  );
}
