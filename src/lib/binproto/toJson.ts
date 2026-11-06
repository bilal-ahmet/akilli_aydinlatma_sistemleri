/**
 * Çözülmüş binary paketi → cihazın bugüne kadar gönderdiği JSON'un aynısı.
 *
 * Firmware ekibinin referans köprüsü `scripts/mqtt_bridge.py`'nin (to_legacy ve
 * yardımcıları) birebir portudur; fonksiyon adları ve sıraları onunla aynı
 * tutuldu ki tablo/kural değişince iki taraf yan yana okunabilsin. Kuralların
 * belgesi: protokol dokümanı "JSON'a çevirme kuralları" bölümü.
 *
 * Python'dan BİLİNÇLİ sapmalar (ekibe de iletildi):
 *  1. Zorunlu alanı eksik banka bloğu `MissingFieldError` atar → paket
 *     reddedilir (Python'da KeyError köprü sürecini düşürüyor).
 *  2. `load_power`: maskeli ham değer ya da geçersiz ölçek `value: null` +
 *     `status` olur (Python 4294967295 W yazıyor; /api/summary toplamı bozulur).
 *  3. d4i_periodic'te ADDRESS zorunlu (adressiz rapor zaten kullanılamaz).
 *
 * Saf modül. Sayısal sonuçlar Python'la birebir aynıdır: `scaled` C'deki gibi
 * döngüyle ×10 / ÷10 yapar (`raw * 10 ** exp` farklı yuvarlar), iki dil de IEEE
 * double kullanır.
 */
import type { DecodedFrame, FieldEntry, FieldValue } from "./codec";
import { espErrToName } from "./espErr";
import {
  COMMAND_ACTIONS,
  COMMAND_RESULT_NOT_ENOUGH_LAMPS,
  COMMAND_RESULT_TEXTS,
  COMMISSION_TRIGGERS,
  DECODE_ERRORS,
  ERRORS,
  MEASUREMENT_STATES,
  MEASUREMENT_STATUSES,
  OTA_MESSAGE_ERROR,
  OTA_MESSAGE_TEXTS,
  OTA_RESULTS,
  OTA_STATES,
  RESET_REASONS,
  THREAD_ROLES,
  type EnumTable,
} from "./fields";

type Json = Record<string, unknown>;
type Fields = Map<string, FieldValue>;

const UNKNOWN = "unknown";
const LED_VOLTAGE_WRAP_V = 65.536; // mqtt_manager.c D4I_LED_VOLTAGE_WRAP_V

/** Banka bloğunun zorunlu alanı pakette yok → paket reddedilir. */
export class MissingFieldError extends Error {
  constructor(readonly field: string) {
    super(`zorunlu alan eksik: ${field}`);
    this.name = "MissingFieldError";
  }
}

/** Çeviri sırasında toplanan uyarılar (bilinmeyen enum değerleri) — loglanır. */
export interface ConvertContext {
  warnings: string[];
}

function num(fields: Fields, name: string): number | undefined {
  const v = fields.get(name);
  return typeof v === "number" ? v : undefined;
}

function req(fields: Fields, name: string): number {
  const v = num(fields, name);
  if (v === undefined) throw new MissingFieldError(name);
  return v;
}

/** Python `bool(fields.get(name))`. */
function flag(fields: Fields, name: string): boolean {
  return !!num(fields, name);
}

/** Python `fields.get(name)` — yoksa null (JSON'da null). */
function opt(fields: Fields, name: string): FieldValue | null {
  return fields.get(name) ?? null;
}

function enumName(table: EnumTable, value: number | undefined, ctx: ConvertContext, label: string) {
  if (value === undefined) return UNKNOWN;
  const name = table[value];
  if (name !== undefined) return name;
  ctx.warnings.push(`bilinmeyen ${label} değeri ${value}`);
  return UNKNOWN;
}

// ── D4i kuralları ────────────────────────────────────────────

const masked8 = (v: number) => v === 0xfe || v === 0xff;
const masked16 = (v: number) => v === 0xfffe || v === 0xffff;
const masked32 = (v: number) => v === 0xfffffffe || v === 0xffffffff;

function unavailableText(value: number, temporaryValue: number): string {
  return value === temporaryValue ? "temporary_unavailable" : "unavailable";
}

export const scaleValid = (scaleRaw: number) => scaleRaw <= 0x06 || scaleRaw >= 0xfa;
export const scaleExponent = (scaleRaw: number) => (scaleRaw >= 0x80 ? scaleRaw - 256 : scaleRaw);

/** mqtt_manager.c d4i_scaled() ile aynı adımlar (aynı double sonucu). */
export function scaled(value: number, scaleRaw: number): number {
  let exponent = scaleExponent(scaleRaw);
  let result = value;
  while (exponent > 0) {
    result *= 10;
    exponent -= 1;
  }
  while (exponent < 0) {
    result /= 10;
    exponent += 1;
  }
  return result;
}

/** u24/u32 sayaç kuralı: 0x..FD doymuş, 0x..FE geçici yok, 0x..FF yok. */
export function addCounter(target: Json, name: string, value: number, bits: number): void {
  const top = 2 ** bits - 1;
  if (value <= top - 2) {
    target[name] = value;
    if (value === top - 2) target[`${name}_saturated`] = true;
    return;
  }
  target[name] = null;
  target[`${name}_status`] = unavailableText(value, top - 1);
}

/** Hata bayrağı + geçmiş sayacı (mqtt_manager.c d4i_add_fault). */
export function addFault(target: Json, name: string, flagValue: number, count: number): void {
  if (flagValue <= 1) {
    target[name] = flagValue;
  } else {
    target[name] = null;
    target[`${name}_status`] =
      flagValue === 0xfe ? "temporary_unavailable" : flagValue === 0xff ? "unavailable" : "invalid";
  }
  if (count <= 0xfd) {
    target[`${name}_count`] = count;
    if (count === 0xfd) {
      target[`${name}_count_saturated`] = true;
      target[`${name}_count_text`] = "253+";
    }
  } else {
    target[`${name}_count`] = null;
    target[`${name}_count_status`] = unavailableText(count, 0xfe);
  }
}

const ENERGY_FIELDS = ["ENERGY_RAW_LOW", "ENERGY_RAW_HIGH", "ENERGY_SCALE", "POWER_RAW", "POWER_SCALE"];
const ENERGY_MASK_TEMP = 0xfffffffffffe;
const ENERGY_MASK = 0xffffffffffff;
const ENERGY_SATURATED = 0xfffffffffffd;

/** energy ve power nesneleri (mqtt_manager.c d4i_add_energy). */
export function energyPowerObjects(fields: Fields, bankNumber: number | undefined): [Json, Json] {
  // 48 bit: 2^53 altında, number'da tam temsil edilir.
  const energyRaw = req(fields, "ENERGY_RAW_HIGH") * 2 ** 32 + req(fields, "ENERGY_RAW_LOW");
  const energyScale = req(fields, "ENERGY_SCALE");
  const powerRaw = req(fields, "POWER_RAW");
  const powerScale = req(fields, "POWER_SCALE");
  const va = bankNumber === 203;

  const energy: Json = {
    raw_integer: String(energyRaw),
    scale_raw: energyScale,
    scale_exponent: scaleValid(energyScale) ? scaleExponent(energyScale) : null,
  };
  if (!scaleValid(energyScale)) {
    energy.value = null;
    energy.status = "invalid_scale";
  } else if (energyRaw === ENERGY_MASK_TEMP || energyRaw === ENERGY_MASK) {
    energy.value = null;
    energy.status = unavailableText(energyRaw, ENERGY_MASK_TEMP);
  } else {
    energy.value = scaled(energyRaw, energyScale);
    if (energyRaw === ENERGY_SATURATED) {
      energy.saturated = true;
      energy.value_is_lower_bound = true;
    }
  }
  energy.unit = va ? "VAh" : "Wh";

  const power: Json = {
    raw_integer: powerRaw,
    scale_raw: powerScale,
    scale_exponent: scaleValid(powerScale) ? scaleExponent(powerScale) : null,
  };
  if (!scaleValid(powerScale)) {
    power.value = null;
    power.status = "invalid_scale";
  } else if (masked32(powerRaw)) {
    power.value = null;
    power.status = unavailableText(powerRaw, 0xfffffffe);
  } else {
    power.value = scaled(powerRaw, powerScale);
    if (powerRaw === 0xfffffffd) {
      power.saturated = true;
      power.value_is_lower_bound = true;
    }
  }
  power.unit = va ? "VA" : "W";
  return [energy, power];
}

export const DRIVER_FAULTS = [
  "general_failure",
  "undervoltage_failure",
  "overvoltage_failure",
  "power_limitation",
  "thermal_derating",
  "thermal_shutdown",
] as const;
export const LED_FAULTS = [
  "general_failure",
  "short_circuit",
  "open_circuit",
  "thermal_derating",
  "thermal_shutdown",
] as const;

export function driverObject(fields: Fields): Json {
  const driver: Json = {
    bank_version: req(fields, "DRIVER_BANK_VERSION"),
    fault_counts_are_historical: true,
  };
  addCounter(driver, "operating_time_s", req(fields, "DRIVER_OPERATING_TIME_S"), 32);
  addCounter(driver, "startup_count", req(fields, "DRIVER_STARTUP_COUNT"), 24);
  const voltage = req(fields, "DRIVER_INPUT_VOLTAGE");
  driver.input_voltage_v = masked16(voltage) ? null : voltage / 10;
  const frequency = req(fields, "DRIVER_MAINS_FREQUENCY");
  driver.mains_frequency_hz = masked8(frequency) ? null : frequency;
  const powerFactor = req(fields, "DRIVER_POWER_FACTOR");
  driver.power_factor = powerFactor <= 100 ? powerFactor / 100 : null;
  const temperature = req(fields, "DRIVER_TEMPERATURE");
  driver.temperature_c = masked8(temperature) ? null : temperature - 60;
  const output = req(fields, "DRIVER_OUTPUT_CURRENT_PERCENT");
  driver.output_current_percent = output <= 100 ? output : null;
  for (const name of DRIVER_FAULTS) {
    const key = `DRIVER_${name.toUpperCase()}`;
    addFault(driver, name, req(fields, key), req(fields, `${key}_COUNT`));
  }
  return driver;
}

/** led nesnesi (mqtt_manager.c d4i_add_diagnostics, bank 206). */
export function ledObject(fields: Fields, sampleCoherent: boolean | null, ctx: ConvertContext): Json {
  const voltageRaw = req(fields, "LED_VOLTAGE");
  const currentRaw = req(fields, "LED_CURRENT");
  const temperatureRaw = req(fields, "LED_TEMPERATURE");
  const voltageAvailable = !masked16(voltageRaw);
  const currentAvailable = !masked16(currentRaw);
  let voltage = voltageAvailable ? voltageRaw / 10 : 0;
  const current = currentAvailable ? currentRaw / 1000 : 0;
  const pairChecked = flag(fields, "LED_VOLTAGE_PLAUSIBILITY_CHECKED");
  const pairPlausible = flag(fields, "LED_VOLTAGE_PLAUSIBLE");
  const temperatureChecked = flag(fields, "LED_TEMPERATURE_PLAUSIBILITY_CHECKED");
  const temperaturePlausible = flag(fields, "LED_TEMPERATURE_PLAUSIBLE");
  const statusCode = num(fields, "LED_MEASUREMENT_STATUS");
  const measurementStatus =
    statusCode !== undefined
      ? enumName(MEASUREMENT_STATUSES, statusCode, ctx, "LED_MEASUREMENT_STATUS")
      : null;

  const led: Json = {
    bank_version: req(fields, "LED_BANK_VERSION"),
    fault_counts_are_historical: true,
  };
  addCounter(led, "startup_count", req(fields, "LED_STARTUP_COUNT"), 24);
  addCounter(led, "operating_time_s", req(fields, "LED_OPERATING_TIME_S"), 32);
  led.sample_coherent = sampleCoherent;
  led.measurement_state = enumName(
    MEASUREMENT_STATES,
    num(fields, "LED_MEASUREMENT_STATE"),
    ctx,
    "LED_MEASUREMENT_STATE",
  );
  if (currentAvailable) led.current_reported_a = current;
  else led.current_status = unavailableText(currentRaw, 0xfffe);
  led.current_available = currentAvailable;
  if (voltageAvailable) led.voltage_reported_v = voltage;
  if (flag(fields, "LED_VOLTAGE_CORRECTED")) {
    voltage = voltage + LED_VOLTAGE_WRAP_V;
    led.voltage_corrected = true;
    led.voltage_corrected_v = voltage;
    led.voltage_correction_reason = "suspected_16bit_mv_wrap";
  }
  const estimated = num(fields, "LED_VOLTAGE_ESTIMATED");
  if (estimated !== undefined) led.voltage_estimated_v = estimated / 10;
  if (pairChecked && !pairPlausible && measurementStatus) {
    led.voltage_implausibility_reason = measurementStatus;
    led.current_implausibility_reason = measurementStatus;
  }

  if (pairChecked && pairPlausible) {
    led.voltage_v = voltage;
    led.current_a = current;
  } else {
    led.voltage_v = null;
    led.current_a = null;
    if (!voltageAvailable) led.voltage_status = unavailableText(voltageRaw, 0xfffe);
  }
  led.voltage_available = voltageAvailable;
  led.voltage_plausible = pairChecked ? pairPlausible : null;
  led.current_plausible = pairChecked ? pairPlausible : null;
  led.voltage_plausibility_checked = pairChecked;
  led.current_plausibility_checked = pairChecked;
  if (measurementStatus) led.measurement_status = measurementStatus;

  for (const name of LED_FAULTS) {
    const key = `LED_${name.toUpperCase()}`;
    addFault(led, name, req(fields, key), req(fields, `${key}_COUNT`));
  }

  const temperatureAvailable = !masked8(temperatureRaw);
  if (temperatureAvailable) {
    const reported = temperatureRaw - 60;
    led.temperature_raw = temperatureRaw;
    led.temperature_reported_c = reported;
    if (temperatureChecked && !temperaturePlausible) {
      led.temperature_implausibility_reason = "gear_temperature_mismatch";
    }
    const tEstimated = num(fields, "LED_TEMPERATURE_ESTIMATED");
    if (tEstimated !== undefined) {
      led.temperature_estimated_c = tEstimated;
      led.temperature_estimation_reason = "suspected_missing_plus_60_offset";
    }
    led.temperature_c = temperatureChecked && temperaturePlausible ? reported : null;
  } else {
    led.temperature_c = null;
    led.temperature_status = unavailableText(temperatureRaw, 0xfe);
  }
  led.temperature_available = temperatureAvailable;
  led.temperature_plausible = temperatureChecked ? temperaturePlausible : null;
  led.temperature_plausibility_checked = temperatureChecked;
  const measurementsAvailable = voltageAvailable && currentAvailable && temperatureAvailable;
  led.measurements_available = measurementsAvailable;
  const plausibilityChecked = pairChecked && temperatureChecked;
  led.measurements_plausibility_checked = plausibilityChecked;
  led.measurements_plausible = plausibilityChecked
    ? measurementsAvailable && pairPlausible && temperaturePlausible
    : null;
  return led;
}

const LOAD_POWER_CHECK_JSON: Record<number, Json> = {
  0: { plausibility_checked: false, plausible: null },
  1: { plausibility_checked: true, plausible: true },
  2: {
    plausibility_checked: true,
    plausible: false,
    implausibility_reason: "led_voltage_current_mismatch",
  },
  3: { plausibility_checked: true, plausible: null },
};

/** Yük gücü (bank 204). Python'dan sapma: maskeli/geçersiz ölçek → value null. */
function loadPowerObject(fields: Fields): Json {
  const raw = req(fields, "LOAD_POWER_RAW");
  const scale = req(fields, "LOAD_POWER_SCALE");
  let loadPower: Json;
  if (!scaleValid(scale)) loadPower = { value: null, status: "invalid_scale", unit: "W" };
  else if (masked32(raw)) loadPower = { value: null, status: unavailableText(raw, 0xfffffffe), unit: "W" };
  else loadPower = { value: scaled(raw, scale), unit: "W" };
  const check = num(fields, "LOAD_POWER_CHECK");
  if (check !== undefined) Object.assign(loadPower, LOAD_POWER_CHECK_JSON[check] ?? LOAD_POWER_CHECK_JSON[0]);
  return loadPower;
}

const DALI_STATUS_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["STATUS", "status"],
  ["CONTROL_GEAR_PRESENT", "control_gear_present"],
  ["LAMP_FAILURE", "lamp_failure"],
  ["LAMP_POWER_ON", "lamp_power_on"],
  ["ACTUAL_LEVEL", "actual_level"],
  ["MAX_LEVEL", "max_level"],
  ["PHYSICAL_MIN_LEVEL", "physical_min_level"],
  ["MIN_LEVEL", "min_level"],
];

function daliStatusKeys(fields: Fields): Json {
  return Object.fromEntries(DALI_STATUS_KEYS.map(([name, key]) => [key, opt(fields, name)]));
}

const hasFields = (fields: Fields, names: readonly string[]) => names.every((n) => fields.has(n));

// ── Mesajlar ─────────────────────────────────────────────────

export function d4iPeriodicJson(fields: Fields, ctx: ConvertContext): Json {
  const out: Json = { type: "d4i_periodic", address: req(fields, "ADDRESS") };
  if (!flag(fields, "ONLINE")) {
    out.online = false;
    out.error = enumName(ERRORS, num(fields, "ERROR"), ctx, "ERROR");
    return out;
  }
  out.online = true;
  out.status = daliStatusKeys(fields);
  out.d4i_supported = flag(fields, "D4I_SUPPORTED");
  if (!out.d4i_supported) return out;

  const d4i: Json = {};
  if (hasFields(fields, ENERGY_FIELDS)) [d4i.energy, d4i.power] = energyPowerObjects(fields, 202);
  if (hasFields(fields, ["LOAD_POWER_RAW", "LOAD_POWER_SCALE"])) d4i.load_power = loadPowerObject(fields);
  if (fields.has("DRIVER_BANK_VERSION")) d4i.driver = driverObject(fields);
  if (fields.has("BANK_206_LENGTH")) d4i.bank_206_length = num(fields, "BANK_206_LENGTH");
  if (fields.has("BANK_206_VERSION")) d4i.bank_206_version = num(fields, "BANK_206_VERSION");
  const sampleCoherent = fields.has("SAMPLE_COHERENT") ? flag(fields, "SAMPLE_COHERENT") : null;
  d4i.sample_coherent = sampleCoherent;
  d4i.sample_state = enumName(MEASUREMENT_STATES, num(fields, "SAMPLE_STATE"), ctx, "SAMPLE_STATE");
  if (fields.has("SAMPLE_STATUS")) {
    d4i.sample_status = enumName(MEASUREMENT_STATUSES, num(fields, "SAMPLE_STATUS"), ctx, "SAMPLE_STATUS");
  }
  if (fields.has("LED_BANK_VERSION")) d4i.led = ledObject(fields, sampleCoherent, ctx);
  out.d4i = d4i;
  if (fields.has("READ_ERRORS")) out.read_errors = fields.get("READ_ERRORS");
  if (fields.has("DECODE_ERRORS")) out.decode_errors = fields.get("DECODE_ERRORS");
  return out;
}

function bytesToHex(v: FieldValue | undefined): string {
  if (!(v instanceof Uint8Array)) return "";
  return Array.from(v, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

export function d4iBankJson(fields: Fields, ctx: ConvertContext): Json {
  const bank = num(fields, "BANK");
  const out: Json = {
    type: "d4i",
    address: opt(fields, "ADDRESS"),
    bank: bank ?? null,
    ok: flag(fields, "BANK_OK"),
  };
  if (!out.ok) {
    if (fields.has("ERROR")) out.error = enumName(ERRORS, num(fields, "ERROR"), ctx, "ERROR");
    if (fields.has("LAST_BANK")) out.last_bank = num(fields, "LAST_BANK");
    return out;
  }
  out.length = opt(fields, "BANK_LENGTH");
  out.raw_hex = bytesToHex(fields.get("BANK_RAW"));
  if (hasFields(fields, ENERGY_FIELDS)) [out.energy, out.power] = energyPowerObjects(fields, bank);
  if (fields.has("DRIVER_BANK_VERSION")) out.driver = driverObject(fields);
  if (fields.has("LED_BANK_VERSION")) out.led = ledObject(fields, null, ctx);
  if (fields.has("DECODE_OK")) out.decode_ok = flag(fields, "DECODE_OK");
  if (fields.has("DECODE_ERROR")) out.decode_error = DECODE_ERRORS[num(fields, "DECODE_ERROR") ?? -1] ?? UNKNOWN;
  return out;
}

export function commissionJson(fields: Fields, ctx: ConvertContext): Json {
  return {
    type: "commission_result",
    trigger: enumName(COMMISSION_TRIGGERS, num(fields, "COMMISSION_TRIGGER"), ctx, "COMMISSION_TRIGGER"),
    count: opt(fields, "COMMISSION_COUNT"),
    addresses: fields.get("COMMISSION_ADDRESSES") ?? [],
    rechecked: fields.get("COMMISSION_RECHECKED") ?? [],
    rx_idle_level: opt(fields, "COMMISSION_RX_IDLE_LEVEL"),
    rx_idle_changed: flag(fields, "COMMISSION_RX_IDLE_CHANGED"),
    duration_ms: opt(fields, "COMMISSION_DURATION_MS"),
  };
}

/**
 * Komut ack'i: `{"action":"dim","id":7,"status":"ok"}` ya da
 * `{…,"status":"error","error":"<firmware metni>"}`. `action` ve `id` yalnızca
 * pakette varsa. Hata metinleri firmware'dekiyle aynı (deviceErrors.ts okur).
 */
export function commandAckJson(fields: Fields, ctx: ConvertContext): Json {
  const out: Json = {};
  const action = num(fields, "COMMAND_ACTION");
  if (action !== undefined) out.action = enumName(COMMAND_ACTIONS, action, ctx, "COMMAND_ACTION");
  const id = num(fields, "COMMAND_ID");
  if (id !== undefined) out.id = id;
  const result = num(fields, "COMMAND_RESULT") ?? 0;
  if (result === 0) {
    out.status = "ok";
    return out;
  }
  out.status = "error";
  if (result === COMMAND_RESULT_NOT_ENOUGH_LAMPS) {
    out.error = `bu efekt en az ${num(fields, "COMMAND_LAMPS_NEEDED") ?? "?"} lamba ister, hatta ${
      num(fields, "COMMAND_LAMPS_AVAILABLE") ?? "?"
    } lamba var`;
  } else {
    const text = COMMAND_RESULT_TEXTS[result];
    if (text === undefined) ctx.warnings.push(`bilinmeyen COMMAND_RESULT değeri ${result}`);
    out.error = text ?? `bilinmeyen hata kodu (${result})`;
  }
  return out;
}

// ── Health ───────────────────────────────────────────────────

/** Bağlantı başına bir kez gelen ve cihaz başına saklanan health alanları. */
export interface BuildInfo {
  idf_version?: string;
  build_date?: string;
  build_time?: string;
  network_name?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** major<<16|minor<<8|patch → "1.0.25" (IDF: "v6.0", patch 0 ise yazılmaz). */
export function versionText(code: number | undefined, idf = false): string {
  if (code === undefined) return "";
  const major = Math.floor(code / 65536);
  const minor = (code >> 8) & 0xff;
  const patch = code & 0xff;
  if (idf) return `v${major}.${minor}${patch ? `.${patch}` : ""}`;
  return `${major}.${minor}.${patch}`;
}

/** Unix saniye → C __DATE__ ("Nov  2 2026") ve __TIME__ ("16:25:51"), UTC. */
export function buildDateTime(timestamp: number): [string, string] {
  const d = new Date(timestamp * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return [
    `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${d.getUTCFullYear()}`,
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
  ];
}

export function otaMessageText(fields: Fields): string {
  const code = num(fields, "OTA_MESSAGE") ?? 0;
  if (code === OTA_MESSAGE_ERROR) return espErrToName(num(fields, "OTA_LAST_ERROR") ?? 0);
  return OTA_MESSAGE_TEXTS[code] ?? UNKNOWN;
}

/**
 * Health JSON'u. `buildInfo` cihazın önbelleğidir: paketteki bir-kezlik alanlar
 * buraya yazılır (yerinde güncellenir), JSON her seferinde buradan doldurulur.
 */
export function healthJson(
  entries: readonly FieldEntry[],
  fields: Fields,
  deviceId: string,
  buildInfo: BuildInfo,
  ctx: ConvertContext,
): Json {
  const idf = num(fields, "HEALTH_IDF_VERSION");
  if (idf !== undefined) buildInfo.idf_version = versionText(idf, true);
  const built = num(fields, "HEALTH_BUILD_TIMESTAMP");
  if (built !== undefined) [buildInfo.build_date, buildInfo.build_time] = buildDateTime(built);
  const networkName = fields.get("THREAD_NETWORK_NAME");
  if (typeof networkName === "string") buildInfo.network_name = networkName;

  // Her NEIGHBOR_RLOC16 yeni komşu başlatır; sonraki NEIGHBOR_* alanları ona ait.
  const neighbors: Json[] = [];
  for (const [name, value] of entries) {
    if (name === "NEIGHBOR_RLOC16") {
      neighbors.push({ rloc16: value });
    } else if (name.startsWith("NEIGHBOR_") && neighbors.length > 0) {
      const current = neighbors[neighbors.length - 1];
      if (name === "NEIGHBOR_IS_CHILD") current.role = value ? "child" : "router";
      else if (name === "NEIGHBOR_RSSI_AVG") current.rssi_avg_dbm = value;
      else if (name === "NEIGHBOR_RSSI_LAST") current.rssi_last_dbm = value;
      else if (name === "NEIGHBOR_LINK_MARGIN") current.link_margin = value;
      else if (name === "NEIGHBOR_LINK_QUALITY_IN") current.link_quality_in = value;
    }
  }

  return {
    type: "health",
    device_id: deviceId,
    uptime_s: opt(fields, "HEALTH_UPTIME_S"),
    free_heap_bytes: opt(fields, "HEALTH_FREE_HEAP_BYTES"),
    firmware_version: versionText(num(fields, "HEALTH_FIRMWARE_VERSION")),
    idf_version: buildInfo.idf_version ?? "",
    build_date: buildInfo.build_date ?? "",
    build_time: buildInfo.build_time ?? "",
    reset_reason: enumName(RESET_REASONS, num(fields, "HEALTH_RESET_REASON"), ctx, "HEALTH_RESET_REASON"),
    mqtt_connected: flag(fields, "HEALTH_MQTT_CONNECTED"),
    dropped_commands: opt(fields, "HEALTH_DROPPED_COMMANDS"),
    // Bir-kezlik (join) alanlar; önbelleğe alınmaz — backend DB sütununda tutar.
    health_interval_s: opt(fields, "HEALTH_INTERVAL_S"),
    report_interval_s: opt(fields, "HEALTH_REPORT_INTERVAL_S"),
    thread: {
      role: enumName(THREAD_ROLES, num(fields, "THREAD_ROLE"), ctx, "THREAD_ROLE"),
      attached: flag(fields, "THREAD_ATTACHED"),
      parent_rssi_avg_dbm: opt(fields, "THREAD_PARENT_RSSI_AVG"),
      parent_rssi_last_dbm: opt(fields, "THREAD_PARENT_RSSI_LAST"),
      parent_link_quality_in: opt(fields, "THREAD_PARENT_LINK_QUALITY_IN"),
      parent_link_quality_out: opt(fields, "THREAD_PARENT_LINK_QUALITY_OUT"),
      rloc16: opt(fields, "THREAD_RLOC16"),
      partition_id: opt(fields, "THREAD_PARTITION_ID"),
      channel: opt(fields, "THREAD_CHANNEL"),
      pan_id: opt(fields, "THREAD_PAN_ID"),
      network_name: buildInfo.network_name ?? "",
      parent_changes: opt(fields, "THREAD_PARENT_CHANGES"),
      partition_id_changes: opt(fields, "THREAD_PARTITION_ID_CHANGES"),
      attach_attempts: opt(fields, "THREAD_ATTACH_ATTEMPTS"),
      neighbors,
    },
    ota: {
      state: enumName(OTA_STATES, num(fields, "OTA_STATE"), ctx, "OTA_STATE"),
      last_result: enumName(OTA_RESULTS, num(fields, "OTA_LAST_RESULT"), ctx, "OTA_LAST_RESULT"),
      busy: flag(fields, "OTA_BUSY"),
      check_count: opt(fields, "OTA_CHECK_COUNT"),
      last_check_uptime_s: opt(fields, "OTA_LAST_CHECK_UPTIME_S"),
      last_success_uptime_s: opt(fields, "OTA_LAST_SUCCESS_UPTIME_S"),
      last_target_version: versionText(num(fields, "OTA_LAST_TARGET_VERSION")),
      last_message: otaMessageText(fields),
      download_percent: opt(fields, "OTA_DOWNLOAD_PERCENT"),
      download_bytes: opt(fields, "OTA_DOWNLOAD_BYTES"),
      download_total_bytes: opt(fields, "OTA_DOWNLOAD_TOTAL_BYTES"),
    },
  };
}

// ── Giriş noktası ────────────────────────────────────────────

/** HELLO'da cihazın /data'ya bastığı düz metin (JSON değil). */
export const HELLO_TEXT = "data";

export type LegacyMessage =
  | { suffix: "data" | "health"; kind: "json"; json: Json }
  | { suffix: "data"; kind: "ack"; json: Json }
  | { suffix: "data"; kind: "hello" };

/**
 * Mesajın eski JSON karşılığı (Python `to_legacy`). Bilinmeyen tip → null.
 * `deviceId` = topic'teki "Meven:<MAC>" (health.device_id'ye yazılır).
 * Zorunlu alan eksikse `MissingFieldError` atar.
 */
export function toLegacy(
  frame: DecodedFrame,
  deviceId: string,
  buildInfo: BuildInfo,
  ctx: ConvertContext,
): LegacyMessage | null {
  const fields: Fields = new Map(frame.fields);
  switch (frame.typeName) {
    case "D4I_PERIODIC":
      return { suffix: "data", kind: "json", json: d4iPeriodicJson(fields, ctx) };
    case "DALI_STATUS":
      return {
        suffix: "data",
        kind: "json",
        json: { type: "dali_status", address: opt(fields, "ADDRESS"), ...daliStatusKeys(fields) },
      };
    case "D4I_BANK":
      return { suffix: "data", kind: "json", json: d4iBankJson(fields, ctx) };
    case "COMMISSION_RESULT":
      return { suffix: "data", kind: "json", json: commissionJson(fields, ctx) };
    case "COMMAND_ACK":
      return { suffix: "data", kind: "ack", json: commandAckJson(fields, ctx) };
    case "HELLO":
      return { suffix: "data", kind: "hello" };
    case "HEALTH":
      return {
        suffix: "health",
        kind: "json",
        json: healthJson(frame.fields, fields, deviceId, buildInfo, ctx),
      };
    default:
      // COMMAND (sunucu → cihaz) ve tanınmayan tipler uplink değildir.
      return null;
  }
}
