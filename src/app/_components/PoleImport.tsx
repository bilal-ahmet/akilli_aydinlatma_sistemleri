"use client";

import { useState } from "react";
import { useLighting } from "@/app/_lib/lighting";
import { useApi } from "@/app/_lib/panel";
import { SAMPLE_CSV } from "@/lib/poleImport";
import type { ImportResultRow } from "@/app/_lib/types";
import { Modal } from "./Modal";

interface Preview {
  rows: ImportResultRow[];
  summary: { total: number; create: number; update: number; error: number };
  columns: string[];
  applied: boolean;
}

const MAX_SHOWN = 300;

const ACTION_LABEL: Record<ImportResultRow["action"], string> = {
  create: "Yeni",
  update: "Güncellenecek",
  error: "Hatalı",
};

/**
 * Direk listesini dosyadan içe aktarma: dosya seç → önizleme (satır başına
 * yeni / güncellenecek / hatalı) → hata yoksa uygula. Ayrıştırma ve
 * doğrulama sunucuda (`/api/poles/import`); burada yalnızca gösterim.
 */
export function PoleImportDialog({ zoneSlug, onClose }: { zoneSlug?: string; onClose: () => void }) {
  const api = useApi();
  const { zones, reloadPoles } = useLighting();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [defaultZone, setDefaultZone] = useState(zoneSlug ?? zones[0]?.id ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(f: { name: string; text: string }, zone: string, apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api("/api/poles/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: f.text, fileName: f.name, defaultZone: zone || undefined, apply }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `İçe aktarma başarısız (${res.status})`);
      setPreview(j.data as Preview);
      if ((j.data as Preview).applied) reloadPoles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bilinmeyen hata");
    } finally {
      setBusy(false);
    }
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 3_000_000) {
      setError("Dosya çok büyük (en fazla 3 MB).");
      return;
    }
    const picked = { name: f.name, text: await f.text() };
    setFile(picked);
    setPreview(null);
    void send(picked, defaultZone, false);
  }

  const s = preview?.summary;
  const missingZone = preview ? !preview.columns.includes("zone") : false;
  // Hatalılar önce: düzeltilecek satırlar tablonun başında görünsün.
  const rows = preview
    ? [...preview.rows].sort((a, b) => Number(b.action === "error") - Number(a.action === "error"))
    : [];
  const canApply = Boolean(file && s && !preview?.applied && s.error === 0 && s.create + s.update > 0 && !busy);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Direkleri içe aktar"
      subtitle="Direk numarası, konum ve bölge bilgisi olan bir CSV ya da GeoJSON dosyası yükleyin."
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-line h-10 px-[18px] text-sm">
            {preview?.applied ? "Kapat" : "İptal"}
          </button>
          {!preview?.applied ? (
            <button
              type="button"
              disabled={!canApply}
              onClick={() => file && send(file, defaultZone, true)}
              className="btn-glow h-10 px-5 text-sm"
            >
              {busy && preview ? "Uygulanıyor…" : s ? `${s.create + s.update} direği kaydet` : "Kaydet"}
            </button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>
        ) : null}

        {preview?.applied ? (
          <p className="rounded-[10px] bg-ok-soft px-3 py-2.5 text-sm text-ok">
            {s!.create} yeni direk eklendi, {s!.update} direk güncellendi.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <label className="btn-line h-10 cursor-pointer px-4 text-sm">
            {file ? "Başka dosya seç" : "Dosya seç"}
            <input type="file" accept=".csv,.txt,.geojson,.json" onChange={pick} className="sr-only" />
          </label>
          {file ? <span className="truncate text-[13px] text-ink-2">{file.name}</span> : null}
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent("﻿" + SAMPLE_CSV)}`}
            download="direkler-ornek.csv"
            className="ml-auto text-[13px] font-medium text-accent hover:underline"
          >
            Örnek dosyayı indir
          </a>
        </div>

        <div className="rounded-xl bg-panel-2 px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
          Sütunlar: <b>kod</b> (direk numarası, zorunlu), <b>enlem</b>, <b>boylam</b>, <b>bölge</b>,{" "}
          <b>cihaz</b> (cihaz kodu), <b>ad</b>, <b>not</b>. Excel&apos;de “CSV (noktalı virgülle
          ayrılmış)” olarak kaydedebilirsiniz. Konum enlem/boylam olmalı (ör. 40,7654 ve 29,9408).
          Aynı numaralı direk varsa güncellenir; boş hücreler mevcut bilgiyi silmez.
        </div>

        {missingZone || !preview ? (
          <div className="max-w-sm">
            <label className="field-label" htmlFor="imp-zone">
              Bölge sütunu yoksa yeni direklerin bölgesi
            </label>
            <select
              id="imp-zone"
              className="field"
              value={defaultZone}
              onChange={(e) => {
                setDefaultZone(e.target.value);
                if (file && preview && !preview.applied) void send(file, e.target.value, false);
              }}
            >
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {busy && !preview ? <p className="text-sm text-muted">Dosya kontrol ediliyor…</p> : null}

        {s ? (
          <>
            <div className="flex flex-wrap gap-2 text-[13px]">
              <span className="rounded-lg border border-border px-3 py-1.5">
                <b className="tabular-nums">{s.create}</b> yeni
              </span>
              <span className="rounded-lg border border-border px-3 py-1.5">
                <b className="tabular-nums">{s.update}</b> güncellenecek
              </span>
              <span
                className={`rounded-lg border px-3 py-1.5 ${s.error > 0 ? "border-danger/40 text-danger" : "border-border"}`}
              >
                <b className="tabular-nums">{s.error}</b> hatalı
              </span>
            </div>
            {s.error > 0 && !preview?.applied ? (
              <p className="text-[13px] text-danger">
                Hatalı satırlar varken kayıt yapılmaz. Dosyayı düzeltip yeniden yükleyin.
              </p>
            ) : null}

            <div className="max-h-[340px] overflow-auto rounded-xl border border-border">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 bg-panel-2 text-[12px] text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Satır</th>
                    <th className="px-3 py-2 font-medium">Direk</th>
                    <th className="px-3 py-2 font-medium">Durum</th>
                    <th className="px-3 py-2 font-medium">Bölge</th>
                    <th className="px-3 py-2 font-medium">Konum</th>
                    <th className="px-3 py-2 font-medium">Açıklama</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_SHOWN).map((r) => (
                    <tr key={r.line} className="border-t border-border align-top">
                      <td className="px-3 py-2 tabular-nums text-muted">{r.line}</td>
                      <td className="px-3 py-2 font-medium text-text">{r.code || "—"}</td>
                      <td className={`px-3 py-2 ${r.action === "error" ? "font-medium text-danger" : "text-ink-2"}`}>
                        {ACTION_LABEL[r.action]}
                      </td>
                      <td className="px-3 py-2 text-ink-2">{r.zoneName ?? "—"}</td>
                      <td className="px-3 py-2 text-ink-2">{r.hasLocation ? "Var" : "—"}</td>
                      <td className="px-3 py-2 text-ink-2">{r.message ?? (r.mac ? "Cihaz bağlanacak" : "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > MAX_SHOWN ? (
              <p className="text-[12.5px] text-muted">İlk {MAX_SHOWN} satır gösteriliyor ({rows.length} satır).</p>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
