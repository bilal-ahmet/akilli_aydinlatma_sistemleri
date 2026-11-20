"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PoleView } from "@/app/_lib/types";
import {
  decodePolyline,
  formatDistance,
  formatDuration,
  googleMapsDirUrl,
  type DirOrigin,
  type LatLng,
} from "@/app/_lib/polyline";
import type { MapRoute } from "./PoleMap";

/**
 * Direğe yol tarifi (Haritalar sayfası, direk paneli).
 *
 * Başlangıç: bulunduğum konum (GPS) · haritada seçilen nokta · başka direk ·
 * adres. Rota sunucuda Google Routes API ile hesaplanır (`POST /api/map/route`,
 * kota korumalı) ve YALNIZCA Google haritasında çizilir. Harita
 * OpenStreetMap'teyse ya da sunucu çizemiyorsa (kota, yapılandırma, hata)
 * istek atılmaz / sonuç yerine "Google Haritalar'da aç" bağlantısı verilir —
 * bu bağlantı ücretsizdir ve her durumda çalışır.
 */

type OriginKind = "me" | "map" | "pole" | "address";
type Mode = "drive" | "walk";

interface RouteData {
  distanceMeters: number;
  durationS: number;
  polyline: string;
  start: LatLng;
  end: LatLng;
  steps: Array<{ text: string; distanceMeters: number }>;
}

type Status =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "loading" }
  | { kind: "done"; route: RouteData }
  | { kind: "fallback"; reason: string }
  | { kind: "error"; message: string };

const ORIGINS: Array<{ key: OriginKind; label: string }> = [
  { key: "me", label: "Konumum" },
  { key: "map", label: "Haritada seç" },
  { key: "pole", label: "Direk" },
  { key: "address", label: "Adres" },
];

const FALLBACK_TEXT: Record<string, string> = {
  osm: "Rota bu haritada çizilemiyor. Yol tarifini Google Haritalar'da açabilirsiniz.",
  unconfigured: "Haritada rota çizimi şu an kullanılamıyor. Yol tarifini Google Haritalar'da açabilirsiniz.",
  quota: "Bugünkü yol tarifi sınırı doldu. Yol tarifini Google Haritalar'da açabilirsiniz.",
  rate_limited: "Kısa sürede çok sayıda rota istendi; birkaç dakika sonra tekrar deneyin ya da Google Haritalar'da açın.",
  failed: "Rota servisine şu an ulaşılamıyor. Yol tarifini Google Haritalar'da açabilirsiniz.",
};

function geoErrorText(err: GeolocationPositionError | null): string {
  if (!err) return "Bu tarayıcı konum bilgisini desteklemiyor.";
  if (err.code === err.PERMISSION_DENIED) {
    return "Konum izni verilmedi. Tarayıcının adres çubuğundan bu siteye konum izni verin ya da başka bir başlangıç seçin.";
  }
  if (err.code === err.TIMEOUT) return "Konum zamanında alınamadı. Tekrar deneyin.";
  return "Konum alınamadı. Konum servislerinin açık olduğundan emin olun.";
}

function currentPosition(): Promise<{ point: LatLng; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ point: { lat: p.coords.latitude, lng: p.coords.longitude }, accuracy: p.coords.accuracy }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

const coordFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 5, maximumFractionDigits: 5 });

let routeSeq = 0;

export function PoleRoute({
  pole,
  poles,
  provider,
  picking,
  pickedPoint,
  onStartPick,
  onCancelPick,
  onRoute,
  onClose,
}: {
  /** Hedef direk (konumlu). */
  pole: PoleView & { lat: number; lng: number };
  /** Müşterinin bütün direkleri (başlangıç direği seçimi için). */
  poles: PoleView[];
  /** Haritanın sağlayıcısı; yalnızca "google"da rota çizilir. */
  provider: "google" | "osm" | null;
  picking: boolean;
  pickedPoint: LatLng | null;
  onStartPick: () => void;
  onCancelPick: () => void;
  onRoute: (route: MapRoute | null) => void;
  onClose: () => void;
}) {
  const [origin, setOrigin] = useState<OriginKind>("me");
  const [mode, setMode] = useState<Mode>("drive");
  const [poleCode, setPoleCode] = useState("");
  const [address, setAddress] = useState("");
  const [myPos, setMyPos] = useState<{ point: LatLng; accuracy: number } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [showSteps, setShowSteps] = useState(false);
  const listId = useId();
  const dest: LatLng = { lat: pole.lat, lng: pole.lng };

  // Kapanınca rota ve harita seçimi temizlenir.
  const cleanup = useRef({ onRoute, onCancelPick });
  useEffect(() => {
    cleanup.current = { onRoute, onCancelPick };
  });
  useEffect(
    () => () => {
      cleanup.current.onRoute(null);
      cleanup.current.onCancelPick();
    },
    [],
  );

  const candidates = poles.filter((p) => p.id !== pole.id && p.lat !== null && p.lng !== null);
  const originPole = candidates.find((p) => p.code.toLocaleLowerCase("tr") === poleCode.trim().toLocaleLowerCase("tr"));

  /** Dış bağlantının başlangıcı; "Konumum"da Google canlı konumu kullanır. */
  const linkOrigin: DirOrigin | undefined =
    origin === "me"
      ? null
      : origin === "map"
        ? (pickedPoint ?? undefined)
        : origin === "pole"
          ? originPole
            ? { lat: originPole.lat!, lng: originPole.lng! }
            : undefined
          : address.trim().length >= 3
            ? { address: address.trim() }
            : undefined;
  const navUrl = linkOrigin === undefined ? null : googleMapsDirUrl(linkOrigin, dest, mode);

  function reset() {
    onRoute(null);
    setStatus({ kind: "idle" });
    setShowSteps(false);
  }

  function chooseOrigin(k: OriginKind) {
    if (k === origin) return;
    setOrigin(k);
    reset();
    if (k === "map") onStartPick();
    else if (picking) onCancelPick();
  }

  async function show() {
    reset();
    let body: Record<string, unknown>;
    if (origin === "me") {
      setStatus({ kind: "locating" });
      try {
        const pos = await currentPosition();
        setMyPos(pos);
        body = { kind: "point", ...pos.point };
      } catch (err) {
        setStatus({ kind: "error", message: geoErrorText(err as GeolocationPositionError | null) });
        return;
      }
    } else if (origin === "map") {
      if (!pickedPoint) {
        onStartPick();
        setStatus({ kind: "error", message: "Önce haritada başlangıç noktasına tıklayın." });
        return;
      }
      body = { kind: "point", ...pickedPoint };
    } else if (origin === "pole") {
      if (!originPole) {
        setStatus({ kind: "error", message: "Listeden konumu girilmiş bir direk seçin." });
        return;
      }
      body = { kind: "pole", poleId: originPole.id };
    } else {
      if (address.trim().length < 3) {
        setStatus({ kind: "error", message: "Başlangıç adresini yazın." });
        return;
      }
      body = { kind: "address", text: address.trim() };
    }

    // Google rotası yalnızca Google haritasında gösterilebilir.
    if (provider !== "google") {
      setStatus({ kind: "fallback", reason: "osm" });
      return;
    }

    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/map/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poleId: pole.id, mode, origin: body }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        setStatus({ kind: "error", message: j?.error ?? "Yol tarifi alınamadı." });
        return;
      }
      const data = j.data as { provider: "google"; route: RouteData } | { provider: "none"; reason: string };
      if (data.provider === "none") {
        setStatus({ kind: "fallback", reason: data.reason });
        return;
      }
      const path = decodePolyline(data.route.polyline);
      setStatus({ kind: "done", route: data.route });
      onRoute({ key: `r${++routeSeq}`, path, start: data.route.start });
    } catch {
      setStatus({ kind: "error", message: "Yol tarifi alınamadı. Bağlantınızı kontrol edin." });
    }
  }

  const busy = status.kind === "locating" || status.kind === "loading";

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-panel-2/60 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow">Yol tarifi</h3>
        <button type="button" onClick={onClose} className="text-[12.5px] font-medium text-muted hover:text-text">
          Kapat
        </button>
      </div>

      {/* Başlangıç */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-muted">Nereden?</span>
        <div role="group" aria-label="Başlangıç noktası" className="grid grid-cols-2 gap-1">
          {ORIGINS.map((o) => (
            <button
              key={o.key}
              type="button"
              aria-pressed={origin === o.key}
              onClick={() => chooseOrigin(o.key)}
              className={`h-8 rounded-lg border px-2 text-[12.5px] font-medium transition-colors ${
                origin === o.key
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-ink-2 hover:text-text"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {origin === "me" ? (
          <p className="text-[12px] text-muted">
            {myPos
              ? `Konumunuz alındı (yaklaşık ${Math.round(myPos.accuracy)} m).`
              : "Konumunuz tarayıcıdan alınır; izin istenebilir."}
          </p>
        ) : null}

        {origin === "map" ? (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {pickedPoint ? (
              <span className="font-mono text-ink-2">
                {coordFmt.format(pickedPoint.lat)}, {coordFmt.format(pickedPoint.lng)}
              </span>
            ) : (
              <span className="text-muted">{picking ? "Haritada başlangıç noktasına tıklayın." : "Nokta seçilmedi."}</span>
            )}
            {!picking ? (
              <button
                type="button"
                onClick={() => {
                  reset();
                  onStartPick();
                }}
                className="font-medium text-accent hover:underline"
              >
                {pickedPoint ? "Değiştir" : "Haritada seç"}
              </button>
            ) : null}
          </div>
        ) : null}

        {origin === "pole" ? (
          <>
            <input
              type="text"
              list={listId}
              value={poleCode}
              onChange={(e) => {
                setPoleCode(e.target.value);
                if (status.kind !== "idle") reset();
              }}
              placeholder="Direk numarası"
              aria-label="Başlangıç direği"
              className="field !h-9 !text-[13px]"
            />
            <datalist id={listId}>
              {candidates.slice(0, 500).map((p) => (
                <option key={p.id} value={p.code}>
                  {p.name ? `${p.name} · ${p.zoneName}` : p.zoneName}
                </option>
              ))}
            </datalist>
            {poleCode.trim() && !originPole ? (
              <p className="text-[12px] text-muted">Bu numarada konumu girilmiş direk yok.</p>
            ) : null}
          </>
        ) : null}

        {origin === "address" ? (
          <input
            type="text"
            value={address}
            maxLength={200}
            onChange={(e) => {
              setAddress(e.target.value);
              if (status.kind !== "idle") reset();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void show();
            }}
            placeholder="Ör. Kocaeli Büyükşehir Belediyesi, İzmit"
            aria-label="Başlangıç adresi"
            className="field !h-9 !text-[13px]"
          />
        ) : null}
      </div>

      {/* Ulaşım ve gönder */}
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Ulaşım şekli" className="flex rounded-lg border border-border p-0.5">
          {(
            [
              ["drive", "Araç"],
              ["walk", "Yaya"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={mode === k}
              onClick={() => {
                if (k !== mode) {
                  setMode(k);
                  reset();
                }
              }}
              className={`h-7 rounded-md px-2.5 text-[12.5px] font-medium ${
                mode === k ? "bg-accent-soft text-accent" : "text-ink-2 hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void show()} disabled={busy} className="btn-glow h-8 flex-1 text-[13px]">
          {status.kind === "locating" ? "Konum alınıyor…" : status.kind === "loading" ? "Hesaplanıyor…" : "Rotayı göster"}
        </button>
      </div>

      {/* Sonuç */}
      {status.kind === "done" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-text">
            <span className="text-base font-semibold">{formatDuration(status.route.durationS)}</span>
            <span className="text-muted"> · {formatDistance(status.route.distanceMeters)}</span>
          </p>
          {status.route.steps.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowSteps((v) => !v)}
                aria-expanded={showSteps}
                className="self-start text-[12.5px] font-medium text-ink-2 hover:text-text"
              >
                {showSteps ? "▾" : "▸"} Adım adım ({status.route.steps.length})
              </button>
              {showSteps ? (
                <ol className="flex flex-col divide-y divide-border rounded-lg border border-border text-[12.5px]">
                  {status.route.steps.map((s, i) => (
                    <li key={i} className="flex gap-2 px-2.5 py-1.5">
                      <span className="w-4 shrink-0 tabular-nums text-muted">{i + 1}.</span>
                      <span className="min-w-0 flex-1 text-text">{s.text}</span>
                      {s.distanceMeters > 0 ? (
                        <span className="shrink-0 tabular-nums text-muted">{formatDistance(s.distanceMeters)}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {status.kind === "fallback" ? (
        <p className="rounded-lg bg-accent-soft px-3 py-2 text-[12.5px] text-text">
          {FALLBACK_TEXT[status.reason] ?? FALLBACK_TEXT.failed}
        </p>
      ) : null}
      {status.kind === "error" ? (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{status.message}</p>
      ) : null}

      {navUrl ? (
        <a
          href={navUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`h-8 text-[13px] ${status.kind === "fallback" ? "btn-glow" : "btn-line"} inline-flex items-center justify-center`}
        >
          {status.kind === "fallback" ? "Google Haritalar'da aç" : "Navigasyonda aç"} ↗
        </a>
      ) : null}
    </section>
  );
}
