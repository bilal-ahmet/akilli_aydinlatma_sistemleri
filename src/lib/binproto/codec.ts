/**
 * Binary MQTT protokolü v1 — paket doğrulama, çözme ve kodlama.
 *
 *   [0x01 versiyon] [alan kodu][değer] … [CRC16 alt bayt][CRC16 üst bayt]
 *
 * - İlk alan her zaman TYPE (0x01).
 * - Değerin boyu alan tablosundan okunur (1-4 bayt, little-endian; i8/i32
 *   ikiye tümleyen). Değişken boylu alanda önce 1 bayt uzunluk gelir.
 * - Değeri olmayan alan pakete hiç yazılmaz (JSON'daki null buradan).
 * - CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, yansıtma yok), versiyon
 *   dahil CRC hariç her şeyin üzerinden.
 *
 * Paketin tamamı doğrulanmadan hiçbir alan döndürülmez. Saf modül.
 */
import {
  FIELDS_BY_CODE,
  FIELDS_BY_NAME,
  LORA_PROTOCOL_VERSION,
  MESSAGE_TYPE_NAMES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type FieldDef,
  type MessageTypeName,
} from "./fields";

export type FieldValue = number | number[] | Uint8Array | string;
/** Paketteki sırasıyla alanlar; aynı ad birden fazla geçebilir (health komşuları). */
export type FieldEntry = readonly [name: string, value: FieldValue];

export interface DecodedFrame {
  ok: true;
  /** TYPE değeri (1-8; bilinmeyen değer de olabilir). */
  type: number;
  /** MESSAGE_TYPES adı; tanınmayan tipte undefined. */
  typeName: MessageTypeName | undefined;
  fields: FieldEntry[];
  length: number;
}

/**
 * Ret nedenleri (dokümandaki çözme algoritması) + LORA: ilk bayt 0x02 olan
 * paket LoRa gateway'inin ayrı protokolüdür; bozuk sayılmaz, henüz desteklenmez.
 */
export type RejectReason =
  | "TOO_SHORT"
  | "VERSION"
  | "CRC"
  | "FIELD"
  | "TRUNCATED"
  | "NO_TYPE"
  | "LORA";

export interface RejectedFrame {
  ok: false;
  reason: RejectReason;
  detail: string;
  /** FIELD'da tanımsız alan kodu. */
  fieldCode?: number;
}

export type DecodeResult = DecodedFrame | RejectedFrame;

const MIN_FRAME = 5; // versiyon + TYPE alanı (2) + CRC (2)

/** CRC-16/CCITT-FALSE. Kontrol: "123456789" → 0x29B1. */
export function crc16(bytes: Uint8Array, end = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

export function toHex(bytes: Uint8Array, sep = " "): string {
  return Array.from(bytes, hex2).join(sep);
}

function readInt(bytes: Uint8Array, at: number, size: number, signed: boolean): number {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = value * 256 + bytes[at + i];
  if (signed) {
    const limit = 2 ** (8 * size);
    if (value >= limit / 2) value -= limit;
  }
  return value;
}

const textDecoder = new TextDecoder("utf-8");

function readValue(def: FieldDef, bytes: Uint8Array, at: number, size: number): FieldValue {
  switch (def.kind) {
    case "text":
      return textDecoder.decode(bytes.subarray(at, at + size));
    case "list":
      return Array.from(bytes.subarray(at, at + size));
    case "bytes":
      return bytes.slice(at, at + size);
    case "i8":
    case "i32":
      return readInt(bytes, at, size, true);
    default:
      return readInt(bytes, at, size, false);
  }
}

export function decodeFrame(input: Uint8Array): DecodeResult {
  const bytes = input;
  if (bytes.length > 0 && bytes[0] === LORA_PROTOCOL_VERSION) {
    return { ok: false, reason: "LORA", detail: "LoRa gateway paketi (0x02)" };
  }
  if (bytes.length < MIN_FRAME) {
    return { ok: false, reason: "TOO_SHORT", detail: `${bytes.length} bayt` };
  }
  if (bytes[0] !== PROTOCOL_VERSION) {
    return { ok: false, reason: "VERSION", detail: `versiyon 0x${hex2(bytes[0])}` };
  }
  const end = bytes.length - 2;
  const received = bytes[end] | (bytes[end + 1] << 8);
  const computed = crc16(bytes, end);
  if (received !== computed) {
    return {
      ok: false,
      reason: "CRC",
      detail: `pakette 0x${received.toString(16).toUpperCase().padStart(4, "0")}, hesaplanan 0x${computed
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")}`,
    };
  }

  const fields: FieldEntry[] = [];
  let i = 1;
  while (i < end) {
    const start = i;
    const code = bytes[i++];
    const def = FIELDS_BY_CODE.get(code);
    if (!def) {
      return {
        ok: false,
        reason: "FIELD",
        detail: `tanımsız alan 0x${hex2(code)} (konum ${start})`,
        fieldCode: code,
      };
    }
    let size = def.size;
    if (size === 0) {
      if (i >= end) return { ok: false, reason: "TRUNCATED", detail: `${def.name} uzunluk baytı yok` };
      size = bytes[i++];
    }
    if (i + size > end) {
      return { ok: false, reason: "TRUNCATED", detail: `${def.name} paketin dışına taşıyor` };
    }
    fields.push([def.name, readValue(def, bytes, i, size)]);
    i += size;
  }

  if (fields.length === 0 || fields[0][0] !== "TYPE") {
    return { ok: false, reason: "NO_TYPE", detail: "ilk alan TYPE değil" };
  }
  const type = fields[0][1] as number;
  return {
    ok: true,
    type,
    typeName: MESSAGE_TYPE_NAMES[type] as MessageTypeName | undefined,
    fields,
    length: bytes.length,
  };
}

// ── Kodlama (mock cihaz, testler, ileride binary komutlar) ────

const textEncoder = new TextEncoder();

function writeInt(out: number[], value: number, size: number): void {
  let v = value < 0 ? 2 ** (8 * size) + value : value;
  for (let i = 0; i < size; i++) {
    out.push(v % 256);
    v = Math.floor(v / 256);
  }
}

/**
 * Bir paketi kodlar. `type` mesaj tipi adı ya da sayısı; TYPE alanı otomatik
 * eklenir. Değeri `undefined`/`null` olan alan pakete yazılmaz (protokol kuralı).
 */
export function encodeFrame(
  type: MessageTypeName | number,
  fields: ReadonlyArray<readonly [name: string, value: FieldValue | null | undefined]>,
): Uint8Array {
  const out: number[] = [PROTOCOL_VERSION, 0x01, typeof type === "number" ? type : MESSAGE_TYPES[type]];
  for (const [name, value] of fields) {
    if (value === undefined || value === null) continue;
    const def = FIELDS_BY_NAME.get(name);
    if (!def) throw new Error(`Bilinmeyen alan: ${name}`);
    out.push(def.code);
    if (def.size === 0) {
      const data =
        typeof value === "string"
          ? textEncoder.encode(value)
          : value instanceof Uint8Array
            ? value
            : Array.isArray(value)
              ? Uint8Array.from(value)
              : null;
      if (!data) throw new Error(`${name} için bayt dizisi/metin bekleniyor`);
      if (data.length > 255) throw new Error(`${name} 255 bayttan uzun`);
      out.push(data.length, ...data);
    } else {
      if (typeof value !== "number") throw new Error(`${name} için sayı bekleniyor`);
      writeInt(out, value, def.size);
    }
  }
  const crc = crc16(Uint8Array.from(out));
  out.push(crc & 0xff, crc >> 8);
  return Uint8Array.from(out);
}

/** "01 01 08 A0 …" / "0x01,0x01" / "010108…" → bayt dizisi. Geçersizse null. */
export function parseHex(text: string): Uint8Array | null {
  const clean = text.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
