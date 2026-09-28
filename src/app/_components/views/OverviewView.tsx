"use client";

import Link from "next/link";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { useZoneStats } from "@/app/_lib/useZoneStats";
import { openAlerts } from "@/app/_lib/alerts";
import { summarize } from "@/app/_lib/mockData";
import { formatInt, formatKw } from "@/app/_lib/format";
import { formatPower, isOnline, splitPower } from "@/app/_lib/deviceHealth";
import { effectByNumber } from "@/lib/effects";
import type { Zone } from "@/app/_lib/types";
import { Toggle } from "../Toggle";
import { BrightnessSlider } from "../BrightnessSlider";
import { PageHeader, StatCard } from "../PanelUi";

const PRESETS = [25, 50, 75, 100];

/** Kahraman kartındaki direk şeridinde en fazla bu kadar bölge gösterilir. */
const MAX_POLES = 6;

const tr1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** "28 Eylül Pazartesi" + "08:32" — saat mount'tan sonra gelir (hidrasyon). */
function useToday() {
  const now = useNow(15_000);
  if (now === null) return { date: "", time: "--:--" };
  const d = new Date(now);
  return {
    date: d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "long" }),
    time: d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
  };
}

/** Sağ üst durum hapı: kaç cihaz son birkaç dakikada rapor verdi. */
function OnlinePill() {
  const { devices } = useLighting();
  const now = useNow(15_000);
  const total = devices.length;
  const online = devices.filter((d) => isOnline(d, now)).length;

  if (total === 0 || now === null) return null;
  const all = online === total;
  const none = online === 0;
  const cls = all
    ? "bg-ok-soft text-ok"
    : none
      ? "bg-danger-soft text-danger"
      : "bg-accent-soft text-accent";
  const dot = all ? "bg-ok" : none ? "bg-danger" : "bg-warn";
  const label = all ? "Sistem çevrimiçi" : none ? "Cihazlara ulaşılamıyor" : "Kısmen çevrimiçi";

  return (
    <div className={`inline-flex h-[34px] items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold ${cls}`}>
      <span aria-hidden className={`h-[7px] w-[7px] rounded-full ${dot}`} />
      {label} · {online}/{total} cihaz
    </div>
  );
}

/** Tek direk: lamba başı + ışık konisi; şiddet konide opaklık olarak görünür. */
function Pole({ zone }: { zone: Zone }) {
  const lvl = zone.isOn ? Math.max(0.15, zone.brightness / 100) : 0;
  return (
    <div className="relative flex h-28 min-w-0 flex-col items-center">
      <div className="absolute bottom-0 top-1.5 w-[3px] rounded-sm bg-[#3a352c]" />
      <div
        className="relative h-[9px] w-[30px] rounded-[5px] transition-[background,box-shadow] duration-500"
        style={
          lvl > 0
            ? {
                background: "oklch(0.9 0.12 85)",
                boxShadow: `0 0 16px 4px oklch(0.8 0.16 72 / ${0.35 + lvl * 0.45}), 0 0 50px 14px oklch(0.75 0.16 65 / ${lvl * 0.35})`,
              }
            : { background: "#4a453b" }
        }
      />
      <div
        className="relative h-[92px] w-full max-w-[130px] transition-opacity duration-500"
        style={{
          clipPath: "polygon(44% 0,56% 0,100% 100%,0 100%)",
          background: "linear-gradient(180deg, oklch(0.85 0.14 78 / .45), oklch(0.8 0.14 72 / 0))",
          opacity: lvl,
        }}
      />
      <div className="absolute bottom-2 max-w-full truncate rounded-[5px] bg-[rgba(20,18,14,.7)] px-[7px] py-0.5 text-[11.5px] text-[#cfc8ba]">
        {zone.name}
      </div>
    </div>
  );
}

/** Koyu "Tüm sistem" kartı: aç/kapa, hızlı şiddet, genel şiddet halkası. */
function SystemHero() {
  const { zones, masterOn, masterBrightness, setAll, setAllBrightness } = useLighting();
  const { canWrite, customerSlug } = usePanel();
  const shown = masterOn ? masterBrightness : 0;
  const onZones = zones.filter((z) => z.isOn).length;
  const fx = new Set(zones.filter((z) => z.isOn && z.activeFx).map((z) => z.activeFx));
  const fxName = fx.size === 1 ? effectByNumber([...fx][0])?.label : null;
  const poles = zones.slice(0, MAX_POLES);

  return (
    <section
      aria-label="Tüm sistem kontrolü"
      className="relative flex flex-col gap-[18px] overflow-hidden rounded-[20px] border border-[rgba(255,220,160,.12)] px-5 pt-6 text-[#f5f2ea] sm:px-[30px] sm:pt-[26px]"
      style={{
        background:
          "radial-gradient(520px 300px at 78% 20%, oklch(0.5 0.13 62 / .55), transparent 70%), radial-gradient(400px 220px at 10% 110%, oklch(0.45 0.1 55 / .35), transparent 70%), #15130f",
      }}
    >
      <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.08em] text-[oklch(0.85_0.12_78)]">
            <span className="h-[7px] w-[7px] rounded-full bg-[oklch(0.85_0.15_78)] shadow-[0_0_10px_oklch(0.85_0.15_78)]" />
            Tüm sistem · canlı
          </p>
          <h2 className="text-[30px] font-bold leading-[1.05] tracking-[-0.025em] sm:text-4xl">
            {masterOn ? "Aydınlatma açık" : "Aydınlatma kapalı"}
          </h2>
          <p className="text-sm text-[#c9c3b6]">
            {zones.length === 0
              ? "Henüz bölge tanımlanmadı."
              : `${onZones}/${zones.length} bölge açık`}
            {fxName ? (
              <>
                {" · efekt: "}
                <span className="text-[#f5f2ea]">{fxName}</span>
              </>
            ) : null}
          </p>

          <fieldset disabled={!canWrite} className="m-0 mt-1 flex min-w-0 flex-col gap-3 border-0 p-0">
            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((p) => {
                const active = masterOn && masterBrightness === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAllBrightness(p)}
                    aria-pressed={active}
                    className={`h-8 rounded-[9px] px-[13px] text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? "bg-[linear-gradient(180deg,oklch(0.84_0.15_78),oklch(0.71_0.18_55))] font-bold text-[#1d1c1a] shadow-[0_0_18px_oklch(0.77_0.16_68/.5)]"
                        : "bg-white/[.07] text-[#d8d2c6] hover:bg-white/[.12]"
                    }`}
                  >
                    %{p}
                  </button>
                );
              })}
              <span aria-hidden className="mx-1.5 h-[22px] w-px bg-white/15" />
              <Link
                href={`/c/${customerSlug}/efektler`}
                className="flex h-8 items-center rounded-[9px] border border-white/15 px-[13px] text-[13px] font-medium text-[#f5f2ea] transition-colors hover:bg-white/[.07]"
              >
                Efektler
              </Link>
              <Toggle
                checked={masterOn}
                onChange={setAll}
                label="Tüm sistemi aç/kapat"
                size="lg"
                onDark
                disabled={!canWrite}
              />
            </div>
            <div className="max-w-md">
              <BrightnessSlider
                value={shown}
                onChange={setAllBrightness}
                label="Genel ışık şiddeti"
                hideValue
                onDark
                disabled={!canWrite}
              />
            </div>
          </fieldset>
        </div>

        {/* Genel şiddet halkası */}
        <div
          className="mx-auto hidden h-[168px] w-[168px] place-items-center rounded-full shadow-[0_0_50px_oklch(0.75_0.16_65/.35)] sm:grid"
          style={{
            background: `conic-gradient(from 200deg, oklch(0.7 0.18 52), oklch(0.86 0.15 80) ${shown}%, rgba(255,255,255,.08) ${shown}% 100%)`,
          }}
          role="img"
          aria-label={`Genel şiddet yüzde ${shown}`}
        >
          <div className="flex h-[140px] w-[140px] flex-col items-center justify-center gap-0.5 rounded-full bg-[#17150f]">
            <span className="font-mono text-[40px] font-semibold tracking-[-0.04em] text-[oklch(0.88_0.13_80)]">
              %{shown}
            </span>
            <span className="text-xs text-[#a8a194]">genel şiddet</span>
          </div>
        </div>
      </div>

      {poles.length > 0 ? (
        <div
          className="grid items-end border-b border-white/[.08]"
          style={{ gridTemplateColumns: `repeat(${poles.length}, minmax(0, 1fr))` }}
        >
          {poles.map((z) => (
            <Pole key={z.id} zone={z} />
          ))}
        </div>
      ) : (
        <div className="pb-6" />
      )}
    </section>
  );
}

/** Amber kart: şebekeden çekilen ölçülmüş güç + sürücü verimi. */
function PowerCard() {
  const { zones, live } = useLighting();
  const measured = live?.powerW ?? null;
  const load = live?.loadPowerW ?? null;
  const efficiency =
    measured !== null && load !== null && measured > 0 ? Math.min(100, Math.round((load / measured) * 100)) : null;
  const big = measured !== null ? splitPower(measured) : null;

  return (
    <section
      aria-label="Çekilen güç"
      className="relative flex min-h-[220px] flex-col justify-between gap-6 overflow-hidden rounded-[20px] px-7 py-[26px] text-[#1d1c1a] shadow-[0_16px_40px_oklch(0.7_0.17_55/.3)]"
      style={{ background: "linear-gradient(150deg, oklch(0.86 0.14 82), oklch(0.72 0.17 55))" }}
    >
      <div aria-hidden className="absolute -right-[60px] -top-[60px] h-[220px] w-[220px] rounded-full bg-white/[.18]" />
      <p className="relative text-xs font-bold uppercase tracking-[.08em] text-[#3a2a10]">
        Çekilen güç · canlı
      </p>
      <div className="relative flex flex-col gap-2.5">
        {big ? (
          <p className="flex items-baseline gap-2">
            <span className="text-[64px] font-bold leading-[.9] tracking-[-0.05em] sm:text-[80px]">{big.value}</span>
            <span className="text-2xl font-semibold">{big.unit}</span>
          </p>
        ) : (
          <p className="text-[64px] font-bold leading-[.9] tracking-[-0.05em]">—</p>
        )}
        <p className="text-[14.5px] leading-normal text-[#2e2412] [text-wrap:pretty]">
          {big ? (
            <>
              {formatInt(live!.powerLamps)} lambadan ölçüldü
              {load !== null ? (
                <>
                  {" · LED'e giden "}
                  <b>{formatPower(load)}</b>
                </>
              ) : null}
            </>
          ) : (
            <>
              Cihazlar henüz ölçüm göndermedi. Direk sayısından tahmin:{" "}
              <b>{formatKw(summarize(zones).powerKw)}</b>
            </>
          )}
        </p>
        {efficiency !== null ? (
          <div className="mt-1 flex flex-col gap-1.5">
            <div
              className="h-1.5 overflow-hidden rounded-[3px] bg-[rgba(29,28,26,.15)]"
              role="img"
              aria-label={`Sürücü verimi yüzde ${efficiency}`}
            >
              <div className="h-full rounded-[3px] bg-[#1d1c1a]" style={{ width: `${efficiency}%` }} />
            </div>
            <p className="text-xs font-medium text-[#3a2a10]">Sürücü verimi %{efficiency}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Bölge şiddetleri: bölge başına tek çubuk (tek seri, tek renk — lejant yok).
 * Kapalı bölgenin çubuğu boş iz olarak kalır. Çubuk bölge detayına gider.
 */
function ZoneLevels() {
  const { zones } = useLighting();
  const { customerSlug } = usePanel();

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-panel px-5 py-[22px] sm:px-[26px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-text">Bölge şiddetleri</h2>
        <p className="text-[12.5px] text-muted">Son komuta göre · kapalı bölge boş görünür</p>
      </div>
      {zones.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">Henüz bölge yok.</p>
      ) : (
        <div className="flex items-end gap-3 overflow-x-auto pb-1 sm:gap-[18px]">
          {zones.map((z) => {
            const pct = z.isOn ? z.brightness : 0;
            return (
              <Link
                key={z.id}
                href={`/c/${customerSlug}/bolgeler/${z.id}`}
                title={`${z.name} — ${z.isOn ? `%${z.brightness}` : "kapalı"}`}
                className="group flex min-w-[56px] flex-1 flex-col items-center gap-2"
              >
                <span className="font-mono text-xs text-ink-2">{z.isOn ? `%${z.brightness}` : "kapalı"}</span>
                <span className="flex h-[150px] w-full max-w-14 items-end overflow-hidden rounded-lg bg-track transition-[filter] group-hover:brightness-95">
                  <span
                    className="block w-full rounded-lg bg-[linear-gradient(180deg,oklch(0.84_0.15_78),oklch(0.71_0.18_55))] shadow-[0_0_22px_oklch(0.77_0.16_68/.5)] transition-[height] duration-500"
                    style={{ height: `${pct}%` }}
                  />
                </span>
                <span className="w-full truncate text-center text-[12.5px] text-muted group-hover:text-text">
                  {z.name}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Bölgeler listesi: tek dokunuşla aç/kapa. */
function ZoneList() {
  const { zones, toggleZone } = useLighting();
  const { canWrite, customerSlug } = usePanel();
  const stats = useZoneStats();

  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-panel px-[22px] py-[22px]">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">Bölgeler</h2>
        <Link href={`/c/${customerSlug}/bolgeler`} className="text-[13px] font-medium text-accent hover:underline">
          Tümü
        </Link>
      </div>
      {zones.length === 0 ? (
        <p className="border-t border-border py-4 text-sm text-muted">Henüz bölge yok.</p>
      ) : (
        zones.map((z) => {
          const power = stats(z.id).measure.powerW;
          return (
            <div key={z.id} className="flex items-center gap-3 border-t border-border py-3">
              <Link href={`/c/${customerSlug}/bolgeler/${z.id}`} className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate text-sm font-semibold text-text hover:text-accent">{z.name}</span>
                <span className="truncate text-[12.5px] text-muted">
                  {z.poleCount} direk · {power !== null ? formatPower(power) : "ölçüm yok"}
                </span>
              </Link>
              <span className="font-mono text-[13px] text-accent">{z.isOn ? `%${z.brightness}` : "—"}</span>
              <Toggle
                checked={z.isOn}
                onChange={(on) => toggleZone(z.id, on)}
                label={`${z.name} aç/kapat`}
                disabled={!canWrite}
              />
            </div>
          );
        })
      )}
    </section>
  );
}

export function OverviewView() {
  const { zones, devices, faults, live } = useLighting();
  const { date, time } = useToday();
  const summary = summarize(zones);
  const alerts = openAlerts(faults, devices);
  const faultyLamps = new Set(faults.map((f) => `${f.deviceId}:${f.channel}`)).size;
  const commandErrors = alerts.length - faults.length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Genel Bakış"
        subtitle={
          <>
            {date} · <span className="font-mono">{time}</span>
          </>
        }
        actions={<OnlinePill />}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SystemHero />
        <PowerCard />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Açık direk"
          value={formatInt(summary.polesOn)}
          unit={`/ ${formatInt(summary.totalPoles)}`}
          hint={summary.polesOff === 0 ? "Kapalı direk yok" : `${formatInt(summary.polesOff)} direk kapalı`}
        />
        <StatCard
          label="Yük gücü"
          value={live?.loadPowerW != null ? splitPower(live.loadPowerW).value : "—"}
          unit={live?.loadPowerW != null ? splitPower(live.loadPowerW).unit : undefined}
          hint={live?.loadPowerW != null ? "LED'e giden güç" : "Cihaz henüz bildirmedi"}
        />
        <StatCard
          label="LED gerilimi (ort.)"
          value={
            live?.ledVoltageV != null
              ? `${live.ledVoltageEstimated ? "≈" : ""}${tr1.format(live.ledVoltageV)}`
              : "—"
          }
          unit={live?.ledVoltageV != null ? "V" : undefined}
          hint={
            live?.ledVoltageV != null
              ? `${formatInt(live.ledVoltageLamps)} lamba ortalaması${live.ledVoltageEstimated ? " (tahmini)" : ""}`
              : "Cihaz henüz bildirmedi"
          }
        />
        <StatCard
          label="Açık arıza"
          value={formatInt(alerts.length)}
          valueClass={alerts.length > 0 ? "text-danger" : "text-text"}
          hint={
            alerts.length === 0
              ? "Tüm cihazlar normal"
              : [
                  faultyLamps > 0 ? `${faultyLamps} lambada arıza` : null,
                  commandErrors > 0 ? `${commandErrors} komut hatası` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ZoneLevels />
        <ZoneList />
      </div>
    </div>
  );
}
