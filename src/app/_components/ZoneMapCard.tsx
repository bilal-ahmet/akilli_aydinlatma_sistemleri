"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { useNow } from "@/app/_lib/useNow";
import { poleStateResolver } from "@/app/_lib/poles";
import type { MapPole } from "./PoleMap";

const PoleMap = dynamic(() => import("./PoleMap").then((m) => m.PoleMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted">Harita yükleniyor…</div>,
});

/**
 * Bölge detayındaki küçük harita: yalnızca bu bölgenin konumlu direkleri.
 * Direğe tıklayınca Harita sayfası o direğe odaklanmış açılır. Konumlu direk
 * yoksa kart çizilmez (direk listesi zaten ne yapılacağını söylüyor).
 */
export function ZoneMapCard({ zone }: { zone: Zone }) {
  const { poles, devices, faultsByDevice } = useLighting();
  const { customerSlug } = usePanel();
  const router = useRouter();
  const now = useNow(15_000);

  const stateOf = poleStateResolver(devices, faultsByDevice, now);
  const mapPoles: MapPole[] = poles
    .filter((p) => p.zoneSlug === zone.id && p.lat !== null && p.lng !== null)
    .map((p) => ({ id: p.id, code: p.code, lat: p.lat!, lng: p.lng!, state: stateOf(p) }));
  if (mapPoles.length === 0) return null;

  const base = `/c/${customerSlug}/harita`;
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-panel">
      <div className="flex items-center justify-between gap-2 px-[22px] py-3.5">
        <h2 className="text-base font-semibold text-text">Haritada</h2>
        <Link href={`${base}?bolge=${encodeURIComponent(zone.id)}`} className="text-[13px] font-medium text-accent hover:underline">
          Haritada aç ›
        </Link>
      </div>
      <div className="h-[260px] border-t border-border bg-panel-2">
        <PoleMap
          poles={mapPoles}
          compact
          fitKey={zone.id}
          onSelect={(id) => {
            if (id) router.push(`${base}?bolge=${encodeURIComponent(zone.id)}&direk=${id}`);
          }}
        />
      </div>
    </section>
  );
}
