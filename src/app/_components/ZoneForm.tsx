"use client";

import { useMemo, useState } from "react";
import type { Zone } from "@/app/_lib/types";
import {
  PROVINCE,
  provinceNames,
  districtsOf,
  neighborhoodsOf,
  composeLocation,
  parseLocation,
} from "@/app/_lib/kocaeli";

export interface ZoneFormValues {
  name: string;
  district: string;
  poleCount: number;
  /** Yalnızca admin + düzenleme: bölgeyi başka müşteriye taşı. */
  customerSlug?: string;
}

interface ZoneFormProps {
  initial?: Zone; // verilirse düzenleme modu
  submitting?: boolean;
  onSubmit: (values: ZoneFormValues) => void;
  onCancel: () => void;
  /**
   * Admin düzenlemesinde bölgenin taşınabileceği müşteriler. Boşsa seçici
   * gösterilmez (müşteri kullanıcısı ya da yeni bölge).
   */
  customers?: { slug: string; name: string }[];
  /** Bölgenin şu anki müşterisi (seçicinin başlangıç değeri). */
  currentCustomer?: string;
}

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

export function ZoneForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
  customers = [],
  currentCustomer,
}: ZoneFormProps) {
  // Düzenlemede kayıtlı `district` metnini (İlçe · Mahalle) tekrar seçimlere ayır.
  const parsed = useMemo(() => parseLocation(initial?.district), [initial?.district]);

  const [province, setProvince] = useState(PROVINCE);
  const [district, setDistrict] = useState(parsed.district);
  const [neighborhood, setNeighborhood] = useState(parsed.neighborhood);
  const [name, setName] = useState(initial?.name ?? "");
  const [poleCount, setPoleCount] = useState(String(initial?.poleCount ?? 0));
  const [customerSlug, setCustomerSlug] = useState(currentCustomer ?? "");
  const showCustomer = Boolean(initial) && customers.length > 1 && Boolean(currentCustomer);
  const moving = showCustomer && customerSlug !== currentCustomer;

  const districts = useMemo(() => districtsOf(province), [province]);
  const neighborhoods = useMemo(
    () => neighborhoodsOf(province, district),
    [province, district],
  );

  const canSubmit =
    name.trim().length > 0 && district.length > 0 && neighborhood.length > 0 && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      district: composeLocation(district, neighborhood),
      poleCount: Math.max(0, parseInt(poleCount, 10) || 0),
      ...(moving ? { customerSlug } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Konum: önce il / ilçe / mahalle, ardından bölge adı seçilir. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor="zf-province">İl *</label>
          <select
            id="zf-province"
            className={inputCls}
            value={province}
            onChange={(e) => {
              setProvince(e.target.value);
              setDistrict("");
              setNeighborhood("");
            }}
          >
            {provinceNames().map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="zf-district">İlçe *</label>
          <select
            id="zf-district"
            className={inputCls}
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
          <label className={labelCls} htmlFor="zf-neighborhood">Mahalle *</label>
          <select
            id="zf-neighborhood"
            className={inputCls}
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
        <label className={labelCls} htmlFor="zf-name">Bölge adı *</label>
        <input
          id="zf-name"
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Örn. Atatürk Bulvarı"
        />
      </div>

      <div>
        <label className={labelCls} htmlFor="zf-poles">Direk sayısı</label>
        <input
          id="zf-poles"
          type="number"
          min={0}
          className={inputCls}
          value={poleCount}
          onChange={(e) => setPoleCount(e.target.value)}
        />
      </div>

      {showCustomer ? (
        <div>
          <label className={labelCls} htmlFor="zf-customer">Müşteri (yönetici)</label>
          <select
            id="zf-customer"
            className={inputCls}
            value={customerSlug}
            onChange={(e) => setCustomerSlug(e.target.value)}
          >
            {customers.map((c) => (
              <option key={c.slug} value={c.slug}>{c.name}</option>
            ))}
          </select>
          {moving ? (
            <p className="mt-2 rounded-lg border border-accent/40 bg-glow/10 px-3 py-2 text-[11px] leading-relaxed text-text">
              <span className="font-semibold text-accent">Bölge cihazlarıyla birlikte taşınır.</span>{" "}
              Bölgenin kısa adı (<code className="font-mono">{initial?.id}</code>) değişmez, bu yüzden
              cihazların yeniden flaşlanması gerekmez. Bölge bu panelden kaybolur ve seçilen
              müşterinin panelinde görünür.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
        >
          İptal
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
        >
          {submitting ? "Kaydediliyor…" : initial ? "Kaydet" : "Ekle"}
        </button>
      </div>
    </form>
  );
}
