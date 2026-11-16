"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { PoleState } from "@/app/_lib/poles";
import {
  acquireGoogleMap,
  googleMapsEnabled,
  onGoogleMapFailure,
  releaseGoogleMap,
  type GoogleMapHandle,
  type MapKind,
} from "@/app/_lib/googleMap";
import { PoleMapLibre } from "./PoleMapLibre";
import { useTheme } from "./ThemeProvider";

/**
 * Direk haritası — sağlayıcı seçici.
 *
 * Google anahtarı varsa bütün haritalar (Haritalar sayfası, bölge kartı, arıza
 * mini haritası) Google Maps ile açılır; örnekler havuzdan gelir
 * (`_lib/googleMap.ts`). Sunucu kota sayacı dolmuşsa (`POST /api/map/session`),
 * anahtar yoksa ya da Google hata verirse MapLibre + OpenStreetMap çizilir —
 * kullanıcı hata görmez.
 *
 * İki uygulama aynı props sözleşmesini paylaşır.
 */

export interface MapPole {
  id: string;
  code: string;
  lat: number;
  lng: number;
  state: PoleState;
}

export interface PoleMapProps {
  /** Konumu olan direkler. */
  poles: MapPole[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Açıkken haritaya tıklama yeni direk konumu verir. */
  addMode?: boolean;
  onAddAt?: (lat: number, lng: number) => void;
  /** Sürüklenerek taşınacak direk (düzenleme). */
  editPole?: { id: string; lat: number; lng: number } | null;
  onMove?: (id: string, lat: number, lng: number) => void;
  /** Değişince harita tüm direkleri kapsayacak şekilde yeniden çerçevelenir. */
  fitKey?: string;
  /** Verilince o noktaya yakınlaşılır (`key` değişince). */
  focus?: { key: string; lat: number; lng: number } | null;
  /** Küçük kart haritası: kaydırma ile yakınlaşma kapalı. */
  compact?: boolean;
  /**
   * Önizleme haritası (arıza kartı): etkileşimsiz, kontrolsüz; verilen noktada
   * sabit açılır, çerçeveleme yapılmaz. Tıklama dışarıdaki bağlantıya bırakılır.
   */
  preview?: { lat: number; lng: number; zoom?: number } | null;
  /** 3 boyutlu görünüm: eğik kamera, binalar ve 3B direkler. */
  view3d?: boolean;
  /** 3B'de sol tuşla / tek parmakla sürükleme haritayı kaydırmak yerine döndürür. */
  rotateDrag?: boolean;
  className?: string;
}

const PoleMapGoogle = dynamic(() => import("./PoleMapGoogle").then((m) => m.PoleMapGoogle), {
  ssr: false,
  loading: () => <Loading />,
});

function Loading() {
  return <div className="grid h-full place-items-center text-sm text-muted">Harita yükleniyor…</div>;
}

export function PoleMap(props: PoleMapProps) {
  const { resolved } = useTheme();
  const scheme = resolved === "dark" ? "dark" : "light";
  const kind: MapKind = props.preview ? "preview" : props.compact ? "compact" : "main";
  const wantGoogle = googleMapsEnabled();
  // undefined: karar bekleniyor · handle null: OpenStreetMap · handle: Google
  const [google, setGoogle] = useState<{ key: string; handle: GoogleMapHandle | null } | undefined>(undefined);
  const key = `${kind}:${scheme}`;

  useEffect(() => {
    if (!wantGoogle) return;
    let alive = true;
    let held: GoogleMapHandle | null = null;
    acquireGoogleMap(kind, scheme).then((handle) => {
      if (!alive) {
        // Beklerken sökülmüşüz: haritayı havuza geri ver.
        if (handle) releaseGoogleMap(handle);
        return;
      }
      held = handle;
      setGoogle({ key, handle });
    });
    // Anahtar / kota hatası harita kurulduktan sonra da gelebilir.
    const off = onGoogleMapFailure(() => {
      held = null;
      if (alive) setGoogle({ key, handle: null });
    });
    return () => {
      alive = false;
      off();
      if (held) releaseGoogleMap(held);
    };
  }, [wantGoogle, kind, scheme, key]);

  if (!wantGoogle) return <PoleMapLibre {...props} />;
  // Tema / tür değiştiyse yeni harita gelene kadar bekle.
  if (!google || google.key !== key) return <Loading />;
  if (!google.handle) return <PoleMapLibre {...props} />;
  return <PoleMapGoogle key={key} handle={google.handle} dark={scheme === "dark"} {...props} />;
}
