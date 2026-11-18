/**
 * CSV üretimi (saf) — admin indirmeleri için. Excel'in Türkçe yerel ayarıyla
 * doğrudan açılsın diye `;` ayırıcı, ondalık virgül ve UTF-8 BOM kullanılır
 * (`PoleImport`'taki örnek dosyayla aynı kural).
 */

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRow = Record<string, CsvValue>;

/**
 * İç içe nesneyi noktalı anahtarlara açar:
 * `{ thread: { channel: 15 } }` → `{ "thread.channel": 15 }`.
 * Diziler (ör. komşu listesi) tek hücrede JSON metni olarak kalır.
 */
export function flattenRecord(value: unknown, prefix = "", out: CsvRow = {}): CsvRow {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = null;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix || "value"] = JSON.stringify(value);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenRecord(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out[prefix || "value"] = value;
  } else {
    out[prefix || "value"] = String(value);
  }
  return out;
}

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "number") s = Number.isFinite(v) ? String(v).replace(".", ",") : "";
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else s = v;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Satırları CSV metnine çevirir. Sütunlar tüm satırların anahtar birleşimidir;
 * `lead` verilen sütunlar başa, kalanlar ilk görülme sırasıyla gelir.
 */
export function toCsv(rows: CsvRow[], lead: string[] = []): string {
  const seen = new Set<string>(lead);
  const cols = [...lead];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  const lines = [cols.map((c) => cell(c)).join(";")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** "2026-11-18T11:03:22Z" → "2026-11-18 14:03:22" (Türkiye saati; Excel tarih olarak okur). */
export function trDateTime(d: Date): string {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return p.replace("T", " ");
}
