/**
 * Direk içe aktarma dosyasını satırlara çevirir (saf; DB'ye dokunmaz).
 * Doğrulama ve uygulama `api/poles/import` route'unda.
 *
 * Biçimler:
 *  - CSV: ayırıcı (`;` `,` sekme) başlık satırından seçilir; tırnaklı alanlar
 *    desteklenir. Excel'in Türkçe CSV'si `;` ve ondalık virgül kullanır.
 *  - GeoJSON: Point feature'ları; koordinat [boylam, enlem], diğer alanlar
 *    `properties`'ten.
 *
 * Sütun adları büyük/küçük harf ve Türkçe karakterden bağımsız eşlenir
 * (`HEADERS`). Koordinatlar WGS84 ondalık derece olmalı.
 */

export type ImportField = "code" | "lat" | "lng" | "zone" | "mac" | "name" | "notes";

export interface ImportRow {
  /** Dosyadaki satır (CSV) ya da feature sırası (GeoJSON), 1 tabanlı. */
  line: number;
  code: string;
  /** Ham metin; sayıya çevirme doğrulamada (ondalık virgül dahil). */
  lat: string;
  lng: string;
  zone: string;
  mac: string;
  name: string;
  notes: string;
}

export type ParseResult = { rows: ImportRow[]; columns: ImportField[] } | { error: string };

/** "Direk No" → "direkno", "Bölge" → "bolge". */
function norm(h: string): string {
  return h
    .trim()
    .toLocaleLowerCase("tr")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c]!)
    .replace(/[^a-z0-9]/g, "");
}

const HEADERS: Record<string, ImportField> = {
  kod: "code", code: "code", direk: "code", direkno: "code", direknumarasi: "code", no: "code", numara: "code", envanterno: "code",
  enlem: "lat", lat: "lat", latitude: "lat", y: "lat",
  boylam: "lng", lng: "lng", lon: "lng", long: "lng", longitude: "lng", x: "lng",
  bolge: "zone", zone: "zone", bolgekodu: "zone", bolgeadi: "zone",
  cihaz: "mac", mac: "mac", cihazmac: "mac", cihazkodu: "mac", device: "mac", deviceid: "mac",
  ad: "name", isim: "name", name: "name", adi: "name",
  not: "notes", notlar: "notes", notes: "notes", aciklama: "notes",
};

function emptyRow(line: number): ImportRow {
  return { line, code: "", lat: "", lng: "", zone: "", mac: "", name: "", notes: "" };
}

/** Tırnak destekli CSV satır bölücü (RFC 4180; satır içi yeni satır dahil). */
function splitCsv(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseCsv(text: string): ParseResult {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [";", "\t", ","].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const table = splitCsv(text, delim);
  if (table.length < 2) return { error: "Dosyada başlık satırı ve en az bir direk satırı olmalı." };

  const map = table[0].map((h) => HEADERS[norm(h)] ?? null);
  if (!map.includes("code")) {
    return { error: "“kod” (direk numarası) sütunu bulunamadı. İlk satır sütun adlarını içermeli." };
  }
  const rows = table.slice(1).map((cells, i) => {
    const r = emptyRow(i + 2);
    map.forEach((field, j) => {
      if (field) r[field] = (cells[j] ?? "").trim();
    });
    return r;
  });
  return { rows, columns: [...new Set(map.filter((f): f is ImportField => f !== null))] };
}

function parseGeoJson(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "GeoJSON dosyası okunamadı (geçersiz JSON)." };
  }
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return { error: "GeoJSON bir FeatureCollection olmalı." };
  const columns = new Set<ImportField>(["lat", "lng"]);
  const rows = features.map((f, i) => {
    const r = emptyRow(i + 1);
    const geom = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
    if (geom?.type === "Point" && Array.isArray(geom.coordinates)) {
      r.lng = String(geom.coordinates[0] ?? "");
      r.lat = String(geom.coordinates[1] ?? "");
    }
    const props = ((f as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      const field = HEADERS[norm(k)];
      if (field && field !== "lat" && field !== "lng" && v != null) {
        r[field] = String(v).trim();
        columns.add(field);
      }
    }
    return r;
  });
  return { rows, columns: [...columns] };
}

/** Dosya adına ya da içeriğe göre biçimi seçer. */
export function parsePoleImport(text: string, fileName = ""): ParseResult {
  const t = text.replace(/^﻿/, ""); // Excel BOM
  const geo = /\.(geo)?json$/i.test(fileName) || t.trimStart().startsWith("{");
  return geo ? parseGeoJson(t) : parseCsv(t);
}

/** "40,7654" ya da "40.7654" → sayı; boş → null; bozuk → NaN. */
export function parseCoord(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  return Number(t.replace(",", "."));
}

/** İndirilebilir örnek CSV (Excel'in Türkçe ayarına uygun `;`). */
export const SAMPLE_CSV =
  "kod;enlem;boylam;bölge;cihaz;ad;not\n" +
  "K-101;40,765400;29,940800;ataturk-bulvari;;Cami önü;\n" +
  "K-102;40,765900;29,941500;ataturk-bulvari;A842E3123456;;Yeni armatür\n";
