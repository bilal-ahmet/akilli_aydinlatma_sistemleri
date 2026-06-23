"use client";

import { useState } from "react";
import type { Zone, ZoneStatus } from "@/app/_lib/types";

export interface ZoneFormValues {
  name: string;
  district: string;
  poleCount: number;
  status: ZoneStatus;
}

const STATUS_OPTIONS: { value: ZoneStatus; label: string }[] = [
  { value: "ok", label: "Çalışıyor" },
  { value: "warning", label: "Uyarı" },
  { value: "fault", label: "Arıza" },
];

interface ZoneFormProps {
  initial?: Zone; // verilirse düzenleme modu
  submitting?: boolean;
  onSubmit: (values: ZoneFormValues) => void;
  onCancel: () => void;
}

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

export function ZoneForm({ initial, submitting, onSubmit, onCancel }: ZoneFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [district, setDistrict] = useState(initial?.district ?? "");
  const [poleCount, setPoleCount] = useState(String(initial?.poleCount ?? 0));
  const [status, setStatus] = useState<ZoneStatus>(initial?.status ?? "ok");

  const canSubmit = name.trim().length > 0 && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      district: district.trim(),
      poleCount: Math.max(0, parseInt(poleCount, 10) || 0),
      status,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label className={labelCls} htmlFor="zf-name">Zon adı *</label>
        <input
          id="zf-name"
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Örn. Atatürk Bulvarı"
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls} htmlFor="zf-district">İlçe / Bölge</label>
          <input
            id="zf-district"
            className={inputCls}
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            placeholder="Örn. Merkez"
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
      </div>

      <div>
        <label className={labelCls} htmlFor="zf-status">Durum</label>
        <select
          id="zf-status"
          className={inputCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as ZoneStatus)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

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
