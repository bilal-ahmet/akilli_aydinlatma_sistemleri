"use client";

import { useMemo, useState } from "react";
import type { Zone } from "@/app/_lib/types";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import {
  PROVINCE,
  provinceNames,
  districtsOf,
  neighborhoodsOf,
  composeLocation,
  parseLocation,
} from "@/app/_lib/kocaeli";
import { Modal } from "./Modal";

/**
 * Yeni bölge / bölge düzenleme diyaloğu. Konum `zones.district` alanına
 * `İlçe · Mahalle` olarak birleşik yazılır (bkz. _lib/kocaeli.ts). Admin
 * düzenlemede bölgeyi cihazlarıyla başka müşteriye taşıyabilir.
 *
 * Parent `key` ile yeniden mount eder (açılışta taze state).
 */
export function ZoneDialog({
  zone,
  onClose,
  onCreated,
}: {
  /** Verilirse düzenleme modu. */
  zone?: Zone;
  onClose: () => void;
  onCreated?: (zone: Zone) => void;
}) {
  const { createZone, updateZone } = useLighting();
  const { customers, customerSlug: currentCustomer } = usePanel();

  // Düzenlemede kayıtlı `district` metnini (İlçe · Mahalle) tekrar seçimlere ayır.
  const parsed = useMemo(() => parseLocation(zone?.district), [zone?.district]);

  const [province, setProvince] = useState(PROVINCE);
  const [district, setDistrict] = useState(parsed.district);
  const [neighborhood, setNeighborhood] = useState(parsed.neighborhood);
  const [name, setName] = useState(zone?.name ?? "");
  const [poleCount, setPoleCount] = useState(zone?.poleCount ?? 0);
  const [customerSlug, setCustomerSlug] = useState(currentCustomer);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provinces = provinceNames();
  const showCustomer = Boolean(zone) && customers.length > 1;
  const moving = showCustomer && customerSlug !== currentCustomer;

  const districts = useMemo(() => districtsOf(province), [province]);
  const neighborhoods = useMemo(() => neighborhoodsOf(province, district), [province, district]);

  const canSubmit =
    name.trim().length > 0 && district.length > 0 && neighborhood.length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const values = {
      name: name.trim(),
      district: composeLocation(district, neighborhood),
      poleCount: Math.max(0, poleCount),
      ...(moving ? { customerSlug } : {}),
    };
    try {
      if (zone) {
        await updateZone(zone.id, values);
      } else {
        const created = await createZone(values);
        onCreated?.(created);
      }
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
      title={zone ? "Bölgeyi düzenle" : "Yeni Bölge"}
      subtitle={zone ? zone.name : "Bir cadde veya sokağı ayrı kontrol için tanımlayın."}
      onSubmit={handleSubmit}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            İptal
          </button>
          <button type="submit" disabled={!canSubmit} className="btn-glow h-10 px-5 text-sm">
            {submitting ? "Kaydediliyor…" : zone ? "Kaydet" : "Bölgeyi oluştur"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        <div>
          <label className="field-label" htmlFor="zf-name">Bölge adı</label>
          <input
            id="zf-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Örn. Cumhuriyet Caddesi"
            autoFocus
          />
        </div>

        {/* Şimdilik tek il tanımlı; ikinci il eklenince seçici görünür. */}
        {provinces.length > 1 ? (
          <div>
            <label className="field-label" htmlFor="zf-province">İl</label>
            <select
              id="zf-province"
              className="field"
              value={province}
              onChange={(e) => {
                setProvince(e.target.value);
                setDistrict("");
                setNeighborhood("");
              }}
            >
              {provinces.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="zf-district">İlçe</label>
            <select
              id="zf-district"
              className="field"
              value={district}
              onChange={(e) => {
                setDistrict(e.target.value);
                setNeighborhood("");
              }}
            >
              <option value="">Seçiniz…</option>
              {districts.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="zf-neighborhood">Mahalle</label>
            <select
              id="zf-neighborhood"
              className="field"
              value={neighborhood}
              disabled={district.length === 0}
              onChange={(e) => setNeighborhood(e.target.value)}
            >
              <option value="">{district ? "Seçiniz…" : "Önce ilçe seçin"}</option>
              {neighborhoods.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="zf-poles">Direk sayısı</label>
          <div className="field flex items-center justify-between pr-1.5 font-mono">
            <input
              id="zf-poles"
              type="number"
              min={0}
              inputMode="numeric"
              value={poleCount}
              onChange={(e) => setPoleCount(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-full min-w-0 bg-transparent outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label="Direk sayısını azalt"
                onClick={() => setPoleCount((n) => Math.max(0, n - 1))}
                className="grid h-8 w-8 place-items-center rounded-[7px] bg-panel-2 text-ink-2 transition-colors hover:text-text"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Direk sayısını artır"
                onClick={() => setPoleCount((n) => n + 1)}
                className="grid h-8 w-8 place-items-center rounded-[7px] bg-panel-2 text-ink-2 transition-colors hover:text-text"
              >
                +
              </button>
            </div>
          </div>
        </div>

        {showCustomer ? (
          <div>
            <label className="field-label" htmlFor="zf-customer">Müşteri (yönetici)</label>
            <select
              id="zf-customer"
              className="field"
              value={customerSlug}
              onChange={(e) => setCustomerSlug(e.target.value)}
            >
              {customers.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </select>
            {moving ? (
              <p className="mt-2 rounded-[10px] bg-accent-soft px-3 py-2 text-[12.5px] leading-relaxed text-text">
                <span className="font-semibold text-accent">Bölge cihazlarıyla birlikte taşınır.</span>{" "}
                Bölgenin kısa adı (<code className="font-mono">{zone?.id}</code>) değişmez, bu yüzden
                cihazların yeniden flaşlanması gerekmez. Bölge bu panelden kaybolur ve seçilen
                müşterinin panelinde görünür.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
