"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useZoneStats } from "@/app/_lib/useZoneStats";
import { splitPower, zoneMeta } from "@/app/_lib/deviceHealth";
import { effectByNumber } from "@/lib/effects";
import { faultLabel } from "@/lib/faults";
import { formatMac } from "@/lib/mac";
import { Toggle } from "../Toggle";
import { BrightnessSlider } from "../BrightnessSlider";
import { useDialogs } from "../PanelDialogs";
import { EmptyBox, PageHeader, PlusIcon, StatCard } from "../PanelUi";
import { DeviceTable } from "./DeviceTable";

const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** Bölge durum noktası: arıza > kapalı > açık. */
function zoneDot(zone: Zone, faulty: boolean): string {
  if (faulty || zone.status === "fault") return "bg-danger";
  if (zone.status === "warning") return "bg-warn";
  return zone.isOn ? "bg-ok" : "bg-border-strong";
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
                {zoneMeta(z, stats(z.id).devices.length)}
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
  const { toggleZone, setZoneBrightness, faultsByDevice } = useLighting();
  const { customerSlug, canWrite } = usePanel();
  const { openZoneForm, confirmDeleteZone, openZoneEffects, openDeviceForm } = useDialogs();
  const router = useRouter();
  const { devices, measure } = useZoneStats()(zone.id);
  const effect = effectByNumber(zone.activeFx);

  const power = measure.powerW !== null ? splitPower(measure.powerW) : null;
  const load = measure.loadPowerW !== null ? splitPower(measure.loadPowerW) : null;
  const noData = "Cihaz henüz bildirmedi";

  // Arızaları cihaza göre grupla — "hangi cihazın hangi lambası" tek satırda.
  const faultGroups = [...faultsByDevice.entries()]
    .map(([deviceId, fs]) => [deviceId, fs.filter((f) => f.zoneSlug === zone.id)] as const)
    .filter(([, fs]) => fs.length > 0);

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
        subtitle={<span className="text-ink-2">{zoneMeta(zone, devices.length)}</span>}
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
            <span className="text-[15px] font-semibold text-text">{zone.isOn ? "Açık" : "Kapalı"}</span>
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
          label="Yük gücü"
          value={load?.value ?? "—"}
          unit={load?.unit}
          hint={load ? "LED'e giden güç" : noData}
        />
      </div>

      {faultGroups.length > 0 ? (
        <section className="flex flex-col gap-1.5 rounded-2xl border border-danger/30 bg-danger-soft px-5 py-4">
          <p className="text-sm font-semibold text-danger">Bu bölgede süren arıza</p>
          {faultGroups.map(([deviceId, fs]) => (
            <p key={deviceId} className="text-[13px] text-ink-2">
              <span className="font-semibold text-text">{fs[0].deviceName || formatMac(deviceId)}</span> ·{" "}
              {fs.map((f) => `Lamba ${f.channel} — ${faultLabel(f.code)}`).join(", ")}
            </p>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-panel">
        <div className="flex items-center justify-between gap-2 px-[22px] py-[18px]">
          <h2 className="text-base font-semibold text-text">Bu bölgedeki cihazlar</h2>
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
            {canWrite ? " “+ Cihaz ekle” ile bu bölgeye bir ESP32 bağlayabilirsiniz." : ""}
          </p>
        ) : (
          <DeviceTable devices={devices} />
        )}
      </section>
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
        <ZoneDetail zone={zone} />
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
