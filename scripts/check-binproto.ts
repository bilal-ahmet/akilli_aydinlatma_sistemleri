/**
 * Binary MQTT protokolü v1 (src/lib/binproto) saf kontrolü. Sunucu/DB/broker
 * gerekmez:  npm run check:binproto
 *
 * Kaynaklar:
 *  - "MQTT Binary Protokolü v1" dokümanı (firmware/MQTT-BINARY-PROTOKOL.html):
 *    CRC kontrol değerleri, örnek paketler ve d4i_periodic JSON karşılığı.
 *  - Firmware ekibinin `mqtt_bridge.py` selftest'i: elle hesaplanmış
 *    beklentiler birebir taşındı (enerji, sayaç/hata, LED, sürüm, OTA mesajı…).
 * Python'dan bilinçli sapmalar (eksik alan, load_power maskesi) ayrıca sınanır.
 */
import { crc16, decodeFrame, encodeFrame, parseHex, type DecodedFrame } from "../src/lib/binproto/codec";
import {
  MissingFieldError,
  addCounter,
  addFault,
  buildDateTime,
  energyPowerObjects,
  ledObject,
  otaMessageText,
  scaled,
  toLegacy,
  versionText,
  LED_FAULTS,
  type BuildInfo,
  type ConvertContext,
  type LegacyMessage,
} from "../src/lib/binproto/toJson";
import { FIELD_DEFS, type MessageTypeName } from "../src/lib/binproto/fields";
import { deviceHealthSchema, parseUplink } from "../src/types/lighting";
import { activeFaultCodes } from "../src/lib/faults";
import { readMeasurement, type D4iBlock } from "../src/lib/d4i";
import { describeDeviceError } from "../src/lib/deviceErrors";
import { encodeCommand } from "../src/lib/binproto/command";
import { ShortIdTable } from "../src/lib/binproto/shortIds";
import { commandAckSchema } from "../src/types/lighting";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Python mqtt_bridge.diff_values gibi: sayılarda göreli 1e-9 tolerans. */
function diff(expected: unknown, actual: unknown, path = "", out: string[] = []): string[] {
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    if (Array.isArray(expected) !== Array.isArray(actual)) {
      out.push(`${path}: tip farklı`);
      return out;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const e = (expected as Record<string, unknown>)[k];
      const a = (actual as Record<string, unknown>)[k];
      const p = path ? `${path}.${k}` : k;
      if (!(k in (actual as object))) out.push(`${p}: çıktıda yok (beklenen ${JSON.stringify(e)})`);
      else if (!(k in (expected as object))) out.push(`${p}: beklenmeyen (${JSON.stringify(a)})`);
      else diff(e, a, p, out);
    }
    return out;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > 1e-9 * Math.max(1, Math.abs(expected))) {
      out.push(`${path}: beklenen ${expected}, çıktı ${actual}`);
    }
    return out;
  }
  if (expected !== actual) out.push(`${path}: beklenen ${JSON.stringify(expected)}, çıktı ${JSON.stringify(actual)}`);
  return out;
}

function same(name: string, actual: unknown, expected: unknown) {
  const d = diff(expected, actual);
  check(name, d.length === 0, d.slice(0, 5).join("; "));
}

const hex = (s: string) => parseHex(s)!;
const ctx = (): ConvertContext => ({ warnings: [] });

function decoded(bytes: Uint8Array): DecodedFrame {
  const f = decodeFrame(bytes);
  if (!f.ok) throw new Error(`paket reddedildi: ${f.reason} ${f.detail}`);
  return f;
}

function legacy(bytes: Uint8Array, info: BuildInfo = {}): LegacyMessage | null {
  return toLegacy(decoded(bytes), "Meven:000000000000", info, ctx());
}

function jsonOf(bytes: Uint8Array, info: BuildInfo = {}): Record<string, unknown> {
  const r = legacy(bytes, info);
  if (!r || r.kind === "hello") throw new Error("JSON üretilmedi");
  return r.json;
}

/** Elle bayt dizisi + doğru CRC (ret testleri için). */
function withCrc(bytes: number[]): Uint8Array {
  const body = Uint8Array.from(bytes);
  const crc = crc16(body);
  return Uint8Array.from([...bytes, crc & 0xff, crc >> 8]);
}

// ── Alan tablosu ─────────────────────────────────────────────
check("alan tablosu 136 alan", FIELD_DEFS.length === 136, String(FIELD_DEFS.length));
check(
  "alan kodları benzersiz",
  new Set(FIELD_DEFS.map((f) => f.code)).size === FIELD_DEFS.length &&
    new Set(FIELD_DEFS.map((f) => f.name)).size === FIELD_DEFS.length,
);

// ── CRC ──────────────────────────────────────────────────────
check("CRC '123456789' = 0x29B1", crc16(new TextEncoder().encode("123456789")) === 0x29b1);
const docPeriodic = hex("01 01 01 02 02 03 01 10 00 11 FF 12 00 13 00 14 00 15 FE 16 55 17 64 20 00 C8 03");
check("CRC doküman paketi (ilk 25 bayt) = 0x03C8", crc16(docPeriodic, 25) === 0x03c8);

// ── Doküman örnek paketleri ──────────────────────────────────
const examples: Record<string, string> = {
  dim: "01 01 08 A0 01 A1 07 00 A2 00 A3 19 17 33",
  efekt: "01 01 08 A0 02 A1 08 00 A2 FF A4 16 A5 05 4D 45 56 45 4E EF DE",
  ackError: "01 01 06 A0 02 A1 08 00 A6 F6 A7 03 A8 01 5C 74",
  periodic: "01 01 01 02 02 03 01 10 00 11 FF 12 00 13 00 14 00 15 FE 16 55 17 64 20 00 C8 03",
  daliStatus: "01 01 02 02 03 10 04 11 FF 12 00 13 FF 14 C8 15 FE 16 55 17 55 46 55",
  health: "01 01 05 B0 80 51 01 00 B2 1A 00 01 C0 02 C2 C2 D0 00 5C D1 00 D2 C3 66 E8",
};
for (const [name, h] of Object.entries(examples)) {
  const r = decodeFrame(hex(h));
  check(`örnek paket geçerli: ${name}`, r.ok, r.ok ? "" : `${r.reason} ${r.detail}`);
}

// Dim komutu: çözüm ve encoder'ın aynı baytları üretmesi
const dim = decoded(hex(examples.dim));
same("dim komutu alanları", Object.fromEntries(dim.fields), {
  TYPE: 8,
  COMMAND_ACTION: 1,
  COMMAND_ID: 7,
  COMMAND_CHANNEL: 0,
  COMMAND_VALUE: 25,
});
const dimEncoded = encodeFrame("COMMAND", [
  ["COMMAND_ACTION", 1],
  ["COMMAND_ID", 7],
  ["COMMAND_CHANNEL", 0],
  ["COMMAND_VALUE", 25],
]);
check("encodeFrame dim = doküman baytları (14 bayt)", Buffer.from(dimEncoded).equals(Buffer.from(hex(examples.dim))));
const efekt = Object.fromEntries(decoded(hex(examples.efekt)).fields);
check("efekt komutu: kanal 255, no 22, metin MEVEN", efekt.COMMAND_CHANNEL === 255 && efekt.COMMAND_EFFECT_NUMBER === 22 && efekt.COMMAND_EFFECT_TEXT === "MEVEN");

// d4i_periodic: dokümandaki JSON'un BİREBİR aynısı (anahtar sırası dahil)
const periodicJson = jsonOf(docPeriodic);
check(
  "d4i_periodic JSON = doküman (birebir)",
  JSON.stringify(periodicJson) ===
    JSON.stringify({
      type: "d4i_periodic",
      address: 2,
      online: true,
      status: {
        status: 0,
        control_gear_present: 255,
        lamp_failure: 0,
        lamp_power_on: 0,
        actual_level: 0,
        max_level: 254,
        physical_min_level: 85,
        min_level: 100,
      },
      d4i_supported: false,
    }),
  JSON.stringify(periodicJson),
);

// Hata ack'i (-10)
const ack = legacy(hex(examples.ackError));
same("hata ack'i JSON", ack?.kind === "ack" ? ack.json : null, {
  action: "efekt",
  id: 8,
  status: "error",
  error: "bu efekt en az 3 lamba ister, hatta 1 lamba var",
});
check(
  "hata ack metni katalogda (not-enough-lamps)",
  ack?.kind === "ack" && describeDeviceError(String(ack.json.error)).code === "not-enough-lamps",
);

// dali_status
same("dali_status JSON", jsonOf(hex(examples.daliStatus)), {
  type: "dali_status",
  address: 3,
  status: 4,
  control_gear_present: 255,
  lamp_failure: 0,
  lamp_power_on: 255,
  actual_level: 200,
  max_level: 254,
  physical_min_level: 85,
  min_level: 85,
});
check("parseUplink dali_status → ignored", parseUplink(jsonOf(hex(examples.daliStatus)))?.kind === "ignored");

// Health parçası (Python selftest: komşu listesi + firmware sürümü)
const health = jsonOf(hex(examples.health));
const thread = health.thread as Record<string, unknown>;
same("health komşu listesi", thread.neighbors, [{ rloc16: 0x5c00, role: "router", rssi_avg_dbm: -61 }]);
check("health firmware 1.0.26", health.firmware_version === "1.0.26", String(health.firmware_version));
check("health uptime 86400, rol child, parent RSSI -62", health.uptime_s === 86400 && thread.role === "child" && thread.parent_rssi_avg_dbm === -62);
check("health deviceHealthSchema'dan geçer", deviceHealthSchema.safeParse(health).success);

// ── Python selftest'inden taşınanlar ─────────────────────────
const energyFields = new Map<string, number>([
  ["ENERGY_RAW_LOW", 123456],
  ["ENERGY_RAW_HIGH", 0],
  ["ENERGY_SCALE", 0],
  ["POWER_RAW", 0xfffffffd],
  ["POWER_SCALE", 0xff],
]);
const [energy, power] = energyPowerObjects(energyFields, 202);
same("enerji", energy, { raw_integer: "123456", scale_raw: 0, scale_exponent: 0, value: 123456, unit: "Wh" });
same("güç doymuş", power, {
  raw_integer: 0xfffffffd,
  scale_raw: 255,
  scale_exponent: -1,
  value: scaled(0xfffffffd, 0xff),
  saturated: true,
  value_is_lower_bound: true,
  unit: "W",
});
const [badScale] = energyPowerObjects(new Map([...energyFields, ["ENERGY_SCALE", 0x10]]), 203);
same("geçersiz ölçek (bank 203 → VAh)", badScale, {
  raw_integer: "123456",
  scale_raw: 16,
  scale_exponent: null,
  value: null,
  status: "invalid_scale",
  unit: "VAh",
});
const [bigEnergy] = energyPowerObjects(
  new Map([...energyFields, ["ENERGY_RAW_HIGH", 0x1234], ["ENERGY_RAW_LOW", 0x89abcdef], ["ENERGY_SCALE", 0xfd]]),
  202,
);
check(
  "48 bit enerji raw_integer ondalık metin",
  bigEnergy.raw_integer === String(0x1234 * 2 ** 32 + 0x89abcdef) && bigEnergy.raw_integer === "20016857337327",
  String(bigEnergy.raw_integer),
);
check("scaled döngüsü: 474 × 10^-1 = 47.4", scaled(474, 0xff) === 47.4);

const fc: Record<string, unknown> = {};
addFault(fc, "general_failure", 0xfe, 0xfd);
addCounter(fc, "startup_count", 0xffffff, 24);
same("hata/sayaç kuralı", fc, {
  general_failure: null,
  general_failure_status: "temporary_unavailable",
  general_failure_count: 253,
  general_failure_count_saturated: true,
  general_failure_count_text: "253+",
  startup_count: null,
  startup_count_status: "unavailable",
});

const ledFields = new Map<string, number>([
  ["LED_BANK_VERSION", 1],
  ["LED_STARTUP_COUNT", 120],
  ["LED_OPERATING_TIME_S", 3500000],
  ["LED_VOLTAGE", 10],
  ["LED_CURRENT", 350],
  ["LED_TEMPERATURE", 100],
  ["LED_MEASUREMENT_STATE", 1],
  ["LED_MEASUREMENT_STATUS", 9],
  ["LED_VOLTAGE_PLAUSIBILITY_CHECKED", 1],
  ["LED_VOLTAGE_PLAUSIBLE", 1],
  ["LED_VOLTAGE_CORRECTED", 1],
  ["LED_VOLTAGE_ESTIMATED", 666],
  ["LED_TEMPERATURE_PLAUSIBILITY_CHECKED", 1],
  ["LED_TEMPERATURE_PLAUSIBLE", 1],
]);
for (const name of LED_FAULTS) {
  ledFields.set(`LED_${name.toUpperCase()}`, 0);
  ledFields.set(`LED_${name.toUpperCase()}_COUNT`, 0);
}
const expectedLed: Record<string, unknown> = {
  bank_version: 1,
  fault_counts_are_historical: true,
  startup_count: 120,
  operating_time_s: 3500000,
  sample_coherent: true,
  measurement_state: "on",
  current_reported_a: 0.35,
  current_available: true,
  voltage_reported_v: 1.0,
  voltage_corrected: true,
  voltage_corrected_v: 1.0 + 65.536,
  voltage_correction_reason: "suspected_16bit_mv_wrap",
  voltage_estimated_v: 66.6,
  voltage_v: 1.0 + 65.536,
  current_a: 0.35,
  voltage_available: true,
  voltage_plausible: true,
  current_plausible: true,
  voltage_plausibility_checked: true,
  current_plausibility_checked: true,
  measurement_status: "voltage_corrected_16bit_mv_wrap",
  temperature_raw: 100,
  temperature_reported_c: 40,
  temperature_c: 40,
  temperature_available: true,
  temperature_plausible: true,
  temperature_plausibility_checked: true,
  measurements_available: true,
  measurements_plausibility_checked: true,
  measurements_plausible: true,
};
for (const name of LED_FAULTS) {
  expectedLed[name] = 0;
  expectedLed[`${name}_count`] = 0;
}
same("LED düzeltilmiş (16 bit taşma)", ledObject(ledFields, true, ctx()), expectedLed);

same("sürüm metinleri", [versionText(0x010019), versionText(0x060000, true), versionText(0x060001, true), versionText(undefined)], [
  "1.0.25",
  "v6.0",
  "v6.0.1",
  "",
]);
same("derleme zamanı", buildDateTime(Date.UTC(2026, 10, 2, 16, 25, 51) / 1000), ["Nov  2 2026", "16:25:51"]);
same(
  "OTA mesajı",
  [
    otaMessageText(new Map([["OTA_MESSAGE", 10]])),
    otaMessageText(new Map([["OTA_MESSAGE", 7], ["OTA_LAST_ERROR", 0x7002]])),
    otaMessageText(new Map([["OTA_MESSAGE", 7], ["OTA_LAST_ERROR", -1]])),
    otaMessageText(new Map()),
  ],
  ["Firmware guncel", "ESP_ERR_HTTP_CONNECT", "ESP_FAIL", ""],
);

// Bütün mesaj tipleri istisnasız çevrilmeli
const samples: Array<[MessageTypeName, Parameters<typeof encodeFrame>[1]]> = [
  ["D4I_PERIODIC", [["ADDRESS", 3], ["ONLINE", 0], ["ERROR", 1]]],
  ["DALI_STATUS", [["ADDRESS", 3], ["ACTUAL_LEVEL", 200]]],
  ["D4I_BANK", [["ADDRESS", 3], ["BANK", 207], ["BANK_OK", 0], ["ERROR", 3], ["LAST_BANK", 206]]],
  [
    "COMMISSION_RESULT",
    [
      ["COMMISSION_TRIGGER", 2],
      ["COMMISSION_COUNT", 1],
      ["COMMISSION_ADDRESSES", [3]],
      ["COMMISSION_RECHECKED", []],
      ["COMMISSION_RX_IDLE_LEVEL", 1],
      ["COMMISSION_RX_IDLE_CHANGED", 0],
      ["COMMISSION_DURATION_MS", 4200],
    ],
  ],
  ["HELLO", []],
];
for (const [type, fields] of samples) {
  let ok = false;
  try {
    ok = legacy(encodeFrame(type, fields)) !== null;
  } catch {
    ok = false;
  }
  check(`çevrilir: ${type}`, ok);
}
check("HELLO → hello", legacy(encodeFrame("HELLO", []))?.kind === "hello");
same("çevrimdışı lamba", jsonOf(encodeFrame(...samples[0])), {
  type: "d4i_periodic",
  address: 3,
  online: false,
  error: "no_response",
});
same(
  "çözülemeyen bank",
  jsonOf(
    encodeFrame("D4I_BANK", [
      ["ADDRESS", 3],
      ["BANK", 206],
      ["BANK_OK", 1],
      ["BANK_LENGTH", 2],
      ["BANK_RAW", Uint8Array.from([0x1f, 0x00])],
      ["DECODE_OK", 0],
      ["DECODE_ERROR", 1],
    ]),
  ),
  {
    type: "d4i",
    address: 3,
    bank: 206,
    ok: true,
    length: 2,
    raw_hex: "1F00",
    decode_ok: false,
    decode_error: "unsupported_bank_layout_or_version",
  },
);
same("commission_result JSON", jsonOf(encodeFrame(...samples[3])), {
  type: "commission_result",
  trigger: "mqtt",
  count: 1,
  addresses: [3],
  rechecked: [],
  rx_idle_level: 1,
  rx_idle_changed: false,
  duration_ms: 4200,
});

// ── Ret durumları ────────────────────────────────────────────
const reason = (b: Uint8Array) => {
  const r = decodeFrame(b);
  return r.ok ? "ok" : r.reason;
};
check("ret: çok kısa", reason(hex("01 01 01")) === "TOO_SHORT");
check("ret: versiyon", reason(withCrc([0x03, 0x01, 0x01])) === "VERSION");
const badCrc = hex(examples.dim);
badCrc[badCrc.length - 1] ^= 0xff;
check("ret: CRC", reason(badCrc) === "CRC");
const unknownField = decodeFrame(withCrc([0x01, 0x01, 0x01, 0x05, 0x00]));
check("ret: tanımsız alan 0x05", !unknownField.ok && unknownField.reason === "FIELD" && unknownField.fieldCode === 0x05);
check("ret: taşma", reason(withCrc([0x01, 0x01, 0x01, 0x30, 0x01])) === "TRUNCATED");
check("ret: değişken alan uzunluğu taşıyor", reason(withCrc([0x01, 0x01, 0x04, 0x92, 0x05, 0x01])) === "TRUNCATED");
check("ret: ilk alan TYPE değil", reason(withCrc([0x01, 0x02, 0x01, 0x01, 0x01])) === "NO_TYPE");
check("LoRa paketi (0x02) ayrı neden", reason(hex("02 10 20 30 40 50")) === "LORA");

// Python'dan sapma 1: eksik zorunlu alan → MissingFieldError (köprü çökmesin)
let missing: unknown = null;
try {
  legacy(encodeFrame("D4I_PERIODIC", [["ADDRESS", 1], ["ONLINE", 1], ["D4I_SUPPORTED", 1], ["DRIVER_BANK_VERSION", 1]]));
} catch (err) {
  missing = err;
}
check("eksik sürücü alanı → MissingFieldError", missing instanceof MissingFieldError, String(missing));

// ── Tam D4i raporu: gerçekçi paket, boyut, şema ve arıza uyumu ─
const fullFields: Parameters<typeof encodeFrame>[1] = [
  ["ADDRESS", 1],
  ["ONLINE", 1],
  ["STATUS", 4],
  ["CONTROL_GEAR_PRESENT", 255],
  ["LAMP_FAILURE", 0],
  ["LAMP_POWER_ON", 255],
  ["ACTUAL_LEVEL", 254],
  ["MAX_LEVEL", 254],
  ["PHYSICAL_MIN_LEVEL", 157],
  ["MIN_LEVEL", 157],
  ["D4I_SUPPORTED", 1],
  ["SAMPLE_COHERENT", 1],
  ["SAMPLE_STATE", 1],
  ["BANK_206_LENGTH", 31],
  ["BANK_206_VERSION", 1],
  ["ENERGY_RAW_LOW", 9971068],
  ["ENERGY_RAW_HIGH", 0],
  ["ENERGY_SCALE", 0xfd],
  ["POWER_RAW", 474],
  ["POWER_SCALE", 0xff],
  ["LOAD_POWER_RAW", 39],
  ["LOAD_POWER_SCALE", 0],
  ["LOAD_POWER_CHECK", 1],
  ["DRIVER_BANK_VERSION", 1],
  ["DRIVER_OPERATING_TIME_S", 1712344],
  ["DRIVER_STARTUP_COUNT", 87],
  ["DRIVER_INPUT_VOLTAGE", 2292],
  ["DRIVER_MAINS_FREQUENCY", 50],
  ["DRIVER_POWER_FACTOR", 95],
  ["DRIVER_TEMPERATURE", 114],
  ["DRIVER_OUTPUT_CURRENT_PERCENT", 85],
  ...(["GENERAL_FAILURE", "UNDERVOLTAGE_FAILURE", "OVERVOLTAGE_FAILURE", "POWER_LIMITATION", "THERMAL_DERATING", "THERMAL_SHUTDOWN"].flatMap(
    (k) => [[`DRIVER_${k}`, 0], [`DRIVER_${k}_COUNT`, k === "THERMAL_DERATING" ? 0xfd : 0]] as const,
  )),
  ["LED_BANK_VERSION", 1],
  ["LED_STARTUP_COUNT", 21998],
  ["LED_OPERATING_TIME_S", 762771],
  ["LED_VOLTAGE", 18],
  ["LED_CURRENT", 592],
  ["LED_TEMPERATURE", 53],
  ...(["GENERAL_FAILURE", "SHORT_CIRCUIT", "OPEN_CIRCUIT", "THERMAL_DERATING", "THERMAL_SHUTDOWN"].flatMap(
    (k) => [[`LED_${k}`, k === "SHORT_CIRCUIT" ? 1 : 0], [`LED_${k}_COUNT`, 10]] as const,
  )),
  ["LED_MEASUREMENT_STATE", 1],
  ["LED_MEASUREMENT_STATUS", 10],
  ["LED_VOLTAGE_PLAUSIBILITY_CHECKED", 1],
  ["LED_VOLTAGE_PLAUSIBLE", 0],
  ["LED_VOLTAGE_ESTIMATED", 659],
  ["LED_TEMPERATURE_PLAUSIBILITY_CHECKED", 1],
  ["LED_TEMPERATURE_PLAUSIBLE", 0],
  ["LED_TEMPERATURE_ESTIMATED", 53],
];
const full = encodeFrame("D4I_PERIODIC", fullFields);
check("tam D4i paketi ≤ 170 bayt", full.length <= 170, `${full.length} bayt`);
const fullJson = jsonOf(full);
const parsed = parseUplink(fullJson);
check("tam D4i parseUplink → d4i", parsed?.kind === "d4i");
if (parsed?.kind === "d4i") {
  same("aktif arıza kodları", activeFaultCodes(parsed.data, fullJson), ["led.short_circuit"]);
  check(
    "enerji ≈ 9971.068 Wh, güç 47.4 W",
    Math.abs((parsed.data.d4i?.energy?.value ?? 0) - 9971.068) < 1e-9 && parsed.data.d4i?.power?.value === 47.4,
    `${parsed.data.d4i?.energy?.value} Wh`,
  );
}
const d4iBlock = fullJson.d4i as Record<string, D4iBlock>;
const v = readMeasurement(d4iBlock.led, "voltage", "v");
check(
  "LED gerilimi doğrulanmadı → tahmini ≈65.9 V, sebep load_power_current_mismatch",
  v?.kind === "estimated" && v.value === 65.9 && v.reason === "load_power_current_mismatch",
  JSON.stringify(v),
);
check("sürücü 229.2 V, 54 °C, PF 0.95", d4iBlock.driver.input_voltage_v === 229.2 && d4iBlock.driver.temperature_c === 54 && d4iBlock.driver.power_factor === 0.95);
check("doymuş sayaç metni 253+", d4iBlock.driver.thermal_derating_count_text === "253+");
check("bank_206_raw_hex yok (binary'de kaldırıldı)", !("bank_206_raw_hex" in d4iBlock));

// Python'dan sapma 2: maskeli yük gücü null olur (4294967295 W değil)
const maskedLoad = jsonOf(
  encodeFrame("D4I_PERIODIC", [["ADDRESS", 1], ["ONLINE", 1], ["D4I_SUPPORTED", 1], ["LOAD_POWER_RAW", 0xffffffff], ["LOAD_POWER_SCALE", 0]]),
);
same("maskeli yük gücü", (maskedLoad.d4i as Record<string, unknown>).load_power, { value: null, status: "unavailable", unit: "W" });
const okLoad = jsonOf(
  encodeFrame("D4I_PERIODIC", [["ADDRESS", 1], ["ONLINE", 1], ["D4I_SUPPORTED", 1], ["LOAD_POWER_RAW", 390], ["LOAD_POWER_SCALE", 0xff], ["LOAD_POWER_CHECK", 2]]),
);
same("yük gücü + tutarsız kontrol", (okLoad.d4i as Record<string, unknown>).load_power, {
  value: 39,
  unit: "W",
  plausibility_checked: true,
  plausible: false,
  implausibility_reason: "led_voltage_current_mismatch",
});

// ── Health: bir-kezlik alanlar önbellekte kalır ──────────────
const info: BuildInfo = {};
const first = jsonOf(
  encodeFrame("HEALTH", [
    ["HEALTH_FIRMWARE_VERSION", 0x01001a],
    ["HEALTH_IDF_VERSION", 0x060000],
    ["HEALTH_BUILD_TIMESTAMP", Date.UTC(2026, 10, 2, 16, 25, 51) / 1000],
    ["HEALTH_RESET_REASON", 1],
    ["THREAD_NETWORK_NAME", "fener-1"],
    ["OTA_STATE", 3],
    ["OTA_BUSY", 1],
    ["OTA_LAST_TARGET_VERSION", 0x01001b],
    ["OTA_MESSAGE", 2],
  ]),
  info,
);
const second = jsonOf(encodeFrame("HEALTH", [["HEALTH_FIRMWARE_VERSION", 0x01001a]]), info);
check(
  "ilk health: idf v6.0, derleme Nov  2 2026, reset power_on",
  first.idf_version === "v6.0" && first.build_date === "Nov  2 2026" && first.reset_reason === "power_on",
);
// OTA_LAST_RESULT pakette yok → Python gibi "unknown".
same("ilk health OTA", first.ota, {
  state: "downloading",
  last_result: "unknown",
  busy: true,
  check_count: null,
  last_check_uptime_s: null,
  last_success_uptime_s: null,
  last_target_version: "1.0.27",
  last_message: "Firmware indiriliyor",
  download_percent: null,
  download_bytes: null,
  download_total_bytes: null,
});
check(
  "ikinci health bir-kezlik alanları önbellekten alır",
  second.idf_version === "v6.0" &&
    second.build_time === "16:25:51" &&
    (second.thread as Record<string, unknown>).network_name === "fener-1",
);
const hp = deviceHealthSchema.safeParse(first);
check("health şeması: firmware + ota", hp.success && hp.data.firmware_version === "1.0.26" && hp.data.ota?.state === "downloading");

// Bilinmeyen enum değeri paketi reddettirmez, "unknown" + uyarı
const warnCtx = ctx();
const unknownEnum = toLegacy(decoded(encodeFrame("HEALTH", [["OTA_STATE", 99]])), "x", {}, warnCtx);
check(
  "bilinmeyen enum → unknown + uyarı",
  unknownEnum?.kind === "json" &&
    (unknownEnum.json.ota as Record<string, unknown>).state === "unknown" &&
    warnCtx.warnings.length === 1,
);

// Yeni firmware hata metinleri katalogda
for (const raw of [
  "d4i rapor servisi henuz hazir degil",
  "cihaz mesgul, komut kuyrugu dolu",
  "crc hatali, paket islenmedi",
  "desteklenmeyen protokol versiyonu",
  "paket bicimi bozuk",
  "efekt icin number (0..28) ve channel (0..63 veya 255) gerekli",
]) {
  check(`hata metni tanınıyor: "${raw}"`, describeDeviceError(raw).known);
}

// ── Binary komut (downlink) ──────────────────────────────────
check(
  "encodeCommand dim = doküman baytları",
  Buffer.from(encodeCommand({ action: "dim", id: 7, channel: 0, value: 25 })).equals(Buffer.from(hex(examples.dim))),
);
check(
  "encodeCommand efekt (kanal 255, Mors) = doküman baytları",
  Buffer.from(encodeCommand({ action: "efekt", id: 8, channel: 255, number: 22, text: "MEVEN" })).equals(
    Buffer.from(hex(examples.efekt)),
  ),
);
const allLamps = Object.fromEntries(decoded(encodeCommand({ action: "efekt", id: 9, number: 14 })).fields);
same("kanalsız efekt: COMMAND_CHANNEL yok (= tüm lambalar), metin yok", allLamps, {
  TYPE: 8,
  COMMAND_ACTION: 2,
  COMMAND_ID: 9,
  COMMAND_EFFECT_NUMBER: 14,
});
const dimAll = Object.fromEntries(decoded(encodeCommand({ action: "dim", id: 10, value: 0 })).fields);
same("kanalsız dim 0 (kapat)", dimAll, { TYPE: 8, COMMAND_ACTION: 1, COMMAND_ID: 10, COMMAND_VALUE: 0 });
check(
  "boş Mors metni yazılmaz",
  !decoded(encodeCommand({ action: "efekt", id: 11, number: 22, text: "" })).fields.some(
    ([n]) => n === "COMMAND_EFFECT_TEXT",
  ),
);
same(
  "bakım: commission=4, ota_check=5",
  [
    Object.fromEntries(decoded(encodeCommand({ action: "commission", id: 12 })).fields).COMMAND_ACTION,
    Object.fromEntries(decoded(encodeCommand({ action: "ota_check", id: 13 })).fields).COMMAND_ACTION,
  ],
  [4, 5],
);
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
check(
  "id 0 / 65536 reddedilir",
  throws(() => encodeCommand({ action: "dim", id: 0, value: 1 })) &&
    throws(() => encodeCommand({ action: "dim", id: 65536, value: 1 })),
);
check("on/off binary'de yok", throws(() => encodeCommand({ action: "on" as "dim" })));

// Kısa id tablosu: 0 atlanır, 65535'ten 1'e döner, TTL'de düşer
const ids = new ShortIdTable(1000, 65534);
same("kısa id sarmalaması 65534 → 65535 → 1", [ids.issue("uuid-a", 0), ids.issue("uuid-b", 0), ids.issue("uuid-c", 0)], [
  65534, 65535, 1,
]);
check("kısa id → UUID", ids.resolve(65535, 500) === "uuid-b");
check("süresi geçen kısa id eşlenmez", ids.resolve(1, 2000) === undefined);
check("verilmemiş kısa id eşlenmez", ids.resolve(42, 0) === undefined);

// Binary ack → JSON ack şeması (id sayı; lib/mqtt.ts shortIds ile UUID'ye çevirir)
const ackOk = legacy(
  encodeFrame("COMMAND_ACK", [
    ["COMMAND_ACTION", 1],
    ["COMMAND_ID", 513],
    ["COMMAND_RESULT", 0],
  ]),
);
const ackParsed = ackOk?.kind === "ack" ? commandAckSchema.safeParse(ackOk.json) : null;
check(
  "binary ack ok → {action:dim, id:513, status:ok}",
  !!ackParsed?.success && ackParsed.data.id === 513 && ackParsed.data.status === "ok" && ackParsed.data.action === "dim",
);
const ackCrc = legacy(encodeFrame("COMMAND_ACK", [["COMMAND_RESULT", -15]]));
check(
  "id'siz CRC ack'i → hata metni, id yok",
  ackCrc?.kind === "ack" && ackCrc.json.id === undefined && ackCrc.json.error === "crc hatali, paket islenmedi",
);

console.log(failures ? `\n${failures} kontrol başarısız` : "\nHepsi geçti");
process.exit(failures ? 1 : 0);
