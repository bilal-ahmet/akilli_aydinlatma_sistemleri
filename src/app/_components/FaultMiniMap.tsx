"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PoleView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useNow } from "@/app/_lib/useNow";
import { poleStateResolver } from "@/app/_lib/poles";
import type { MapPole } from "./PoleMap";

const PoleMap = dynamic(() => import("./PoleMap").then((m) => m.PoleMap), {
  ssr: false,
  loading: () => <MapPlaceholder text="Harita yükleniyor…" />,
});

function MapPlaceholder({ text }: { text: string }) {
  return <div className="grid h-full place-items-center text-[12px] text-muted">{text}</div>;
}

/**
 * Süren arıza kartındaki küçük harita: arızalı direk ortada ve vurgulu,
 * çevresindeki direkler durum renkleriyle. Etkileşimsizdir; tıklayınca Harita
 * sayfası o direğe odaklı açılır.
 *
 * Harita yalnızca kart ekrana yaklaşınca takılır, uzaklaşınca sökülür:
 * Google'da örnek havuza döner ve sıradaki karta verilir (aynı anda görünen
 * kart sayısı kadar yükleme), MapLibre'de WebGL bağlam sınırına (~16)
 * takılmaz.
 */
export function FaultMiniMap({ pole, href }: { pole: PoleView; href: string }) {
  const { poles, devices, faultsByDevice } = useLighting();
  const now = useNow(15_000);
  const ref = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const stateOf = poleStateResolver(devices, faultsByDevice, now);
  const mapPoles: MapPole[] = poles
    .filter((p) => p.lat !== null && p.lng !== null && p.zoneSlug === pole.zoneSlug)
    .map((p) => ({ id: p.id, code: p.code, lat: p.lat!, lng: p.lng!, state: stateOf(p) }));

  return (
    <Link
      ref={ref}
      href={href}
      aria-label={`Direk ${pole.code} haritada`}
      title="Haritada aç"
      className="group relative block h-[150px] w-full shrink-0 overflow-hidden rounded-[10px] border border-border bg-panel-2 sm:h-[124px] sm:w-[200px]"
    >
      {visible ? (
        <PoleMap
          poles={mapPoles}
          selectedId={pole.id}
          preview={{ lat: pole.lat!, lng: pole.lng! }}
          className="pointer-events-none"
        />
      ) : (
        <MapPlaceholder text="Harita" />
      )}
      <span className="pointer-events-none absolute right-1.5 top-1.5 rounded-md bg-panel/90 px-1.5 py-0.5 text-[11.5px] font-medium text-text shadow-sm">
        Direk {pole.code}
      </span>
      <span className="pointer-events-none absolute inset-0 rounded-[10px] ring-accent/0 transition group-hover:ring-2 group-hover:ring-accent/60" />
    </Link>
  );
}
