"use client";

import { useState } from "react";
import type { PoleView } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { useTechnical } from "@/app/_lib/panel";
import { deviceName } from "@/app/_lib/format";
import { inTurkey, parseCoordinatePair } from "@/app/_lib/poles";
import type { PoleLocationSource } from "@/types/lighting";
import { Modal } from "./Modal";

const coordFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, useGrouping: false });

function formatPair(lat: number | null, lng: number | null): string {
  return lat !== null && lng !== null ? `${coordFmt.format(lat)}, ${coordFmt.format(lng)}` : "";
}

/**
 * Yeni direk / direk düzenleme. Konum tek alanda "enlem, boylam" olarak
 * girilir (Google Maps'ten kopyalanan biçim), "Konumumu kullan" sahadaki
 * tarayıcının GPS'ini alır; haritadan gelince (`initialLocation`) dolu açılır.
 * Cihaz seçimi yalnızca seçili bölgedeki boş cihazları listeler (bir direkte
 * tek cihaz, cihaz ile direk aynı bölgede).
 *
 * Parent `key` ile yeniden mount eder (açılışta taze state).
 */
export function PoleDialog({
  pole,
  zoneSlug: presetZone,
  initialLocation,
  onClose,
  onSaved,
}: {
  /** Verilirse düzenleme modu. */
  pole?: PoleView;
  zoneSlug?: string;
  /** Haritaya tıklanarak açıldıysa nokta. */
  initialLocation?: { lat: number; lng: number };
  onClose: () => void;
  onSaved?: (pole: PoleView) => void;
}) {
  const { zones, devices, createPole, updatePole } = useLighting();
  const technical = useTechnical();
  const [zoneSlug, setZoneSlug] = useState(pole?.zoneSlug ?? presetZone ?? zones[0]?.id ?? "");
  const [code, setCode] = useState(pole?.code ?? "");
  const [name, setName] = useState(pole?.name ?? "");
  const [notes, setNotes] = useState(pole?.notes ?? "");
  const [coords, setCoords] = useState(
    initialLocation
      ? formatPair(initialLocation.lat, initialLocation.lng)
      : formatPair(pole?.lat ?? null, pole?.lng ?? null),
  );
  const [source, setSource] = useState<PoleLocationSource | null>(
    initialLocation ? "map" : ((pole?.locationSource as PoleLocationSource | null) ?? null),
  );
  const [accuracy, setAccuracy] = useState<number | null>(pole?.locationAccuracyM ?? null);
  const [deviceMac, setDeviceMac] = useState(pole?.deviceId ?? "");
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = coords.trim() ? parseCoordinatePair(coords) : null;
  const coordsInvalid = coords.trim() !== "" && parsed === null;
  const outside = parsed !== null && !inTurkey(parsed.lat, parsed.lng);
  const zoneChanged = pole ? zoneSlug !== pole.zoneSlug : false;

  // Bölgedeki boş cihazlar + bu direğin şu anki cihazı.
  const candidates = devices.filter(
    (d) => d.zoneSlug === zoneSlug && (!d.poleId || d.poleId === pole?.id),
  );
  // Bölge değişince önceki seçim yeni bölgede yoksa boşalt.
  const mac = candidates.some((d) => d.deviceId === deviceMac) ? deviceMac : "";

  const canSubmit = !submitting && zoneSlug !== "" && code.trim() !== "" && !coordsInvalid && !locating;

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setError("Bu tarayıcı konum vermiyor.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(formatPair(pos.coords.latitude, pos.coords.longitude));
        setSource("gps");
        setAccuracy(Math.round(pos.coords.accuracy));
        setLocating(false);
      },
      () => {
        setError("Konum alınamadı. Tarayıcıda konum iznini kontrol edin.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const lat = parsed?.lat ?? null;
    const lng = parsed?.lng ?? null;
    // Konum değişmediyse gönderilmez — kaynağı (GPS, içe aktarma) korunur.
    const locationChanged = !pole || lat !== pole.lat || lng !== pole.lng;
    const location = locationChanged
      ? {
          lat,
          lng,
          ...(parsed ? { locationSource: source ?? "manual" } : {}),
          ...(parsed && source === "gps" && accuracy !== null ? { locationAccuracyM: accuracy } : {}),
        }
      : {};
    const base = {
      zoneSlug,
      code: code.trim(),
      name: name.trim(),
      notes: notes.trim(),
      deviceMac: zoneChanged && pole?.deviceId ? "" : mac,
    };
    try {
      const saved = pole
        ? await updatePole(pole.id, { ...base, ...location })
        : await createPole({ ...base, lat, lng, ...location });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={pole ? "Direği düzenle" : "Yeni direk"}
      subtitle={pole ? pole.code : "Direği bir bölgeye ekleyin; konumu şimdi ya da sonra girebilirsiniz."}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            İptal
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-glow h-10 px-5 text-sm">
            {submitting ? "Kaydediliyor…" : pole ? "Kaydet" : "Direği ekle"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        <div className="grid gap-[18px] sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="pl-code">Direk numarası</label>
            <input
              id="pl-code"
              className="field"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Örn. K-104"
              autoFocus={!pole}
              maxLength={50}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="pl-zone">Bölge</label>
            <select id="pl-zone" className="field" value={zoneSlug} onChange={(e) => setZoneSlug(e.target.value)}>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
        </div>
        {zoneChanged && pole?.deviceId ? (
          <p className="-mt-2 rounded-[10px] bg-accent-soft px-3 py-2 text-[12.5px] leading-relaxed text-text">
            Bölge değişince direkteki cihaz direkten ayrılır; cihaz kendi bölgesinde kalır.
          </p>
        ) : null}

        <div>
          <label className="field-label" htmlFor="pl-name">
            Ad <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <input
            id="pl-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Cami önü"
            maxLength={100}
          />
        </div>

        <div>
          <div className="flex items-end justify-between gap-2">
            <label className="field-label" htmlFor="pl-coords">
              Konum <span className="font-normal text-muted">(enlem, boylam)</span>
            </label>
            <button
              type="button"
              onClick={useMyLocation}
              disabled={locating}
              className="mb-[7px] text-[12.5px] font-medium text-accent hover:underline disabled:opacity-50"
            >
              {locating ? "Konum alınıyor…" : "Konumumu kullan"}
            </button>
          </div>
          <input
            id="pl-coords"
            className="field font-mono"
            value={coords}
            onChange={(e) => {
              setCoords(e.target.value);
              setSource("manual");
              setAccuracy(null);
            }}
            placeholder="40.765400, 29.940800"
            spellCheck={false}
            inputMode="decimal"
          />
          <p className={`mt-2 text-[12.5px] leading-normal ${coordsInvalid || outside ? "text-danger" : "text-muted"}`}>
            {coordsInvalid
              ? "Konum anlaşılamadı. Enlem ve boylamı virgülle ayırarak yazın: 40.7654, 29.9408"
              : outside
                ? "Bu konum Türkiye dışında görünüyor. Enlem ile boylamın yerini kontrol edin."
                : source === "gps" && accuracy !== null
                  ? `Telefon konumu alındı (yaklaşık ${accuracy} m doğrulukla).${accuracy > 20 ? " Doğruluk düşük, direğin yanında tekrar deneyin." : ""}`
                  : "Google Haritalar'da noktaya sağ tıklayıp kopyaladığınız değeri yapıştırabilirsiniz. Boş bırakılırsa konum sonra girilir."}
          </p>
        </div>

        <div>
          <label className="field-label" htmlFor="pl-device">
            Cihaz <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <select id="pl-device" className="field" value={mac} onChange={(e) => setDeviceMac(e.target.value)}>
            <option value="">Cihaz takılı değil</option>
            {candidates.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {deviceName(d, technical)}
                {d.lampCount > 0 ? ` · ${d.lampCount} lamba` : ""}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[12.5px] leading-normal text-muted">
            {candidates.length === 0
              ? "Bu bölgede direğe bağlanmamış cihaz yok."
              : "Direğin lambaları bu cihazdan izlenir. Listede yalnızca bu bölgedeki boş cihazlar var."}
          </p>
        </div>

        <div>
          <label className="field-label" htmlFor="pl-notes">
            Not <span className="font-normal text-muted">(isteğe bağlı)</span>
          </label>
          <textarea
            id="pl-notes"
            className="field !h-20 py-2.5"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={1000}
          />
        </div>
      </div>
    </Modal>
  );
}
