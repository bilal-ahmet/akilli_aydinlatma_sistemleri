/*
 * Sanal ESP32 (mock device) — donanımsız test. ESP ekibinin güncel kontratını
 * birebir taklit eder:
 *   - subscribe Meven:<MAC>/cmd , Meven:<ZONE>/cmd , Meven:all/cmd
 *   - gelen { action, value, number, channel, id } komutunu DOĞRULAR ve sonucu
 *     Meven:<MAC>/data'ya {"action","id","status":"ok"} / {...,"status":"error","error":"..."}
 *     olarak yayınlar (firmware 1.0.9: action + id aynen geri gelir; hata
 *     metinleri firmware'dekiyle aynı)
 *   - her DALI adresi için periyodik {"type":"d4i_periodic", ...} raporu
 *   - bakım komutları: "commission" (yeni lamba bulur, boş kanala koyar) ve
 *     "ota_check" (checking → downloading → verifying → updated, sürüm artar)
 *   - Meven:<MAC>/health'e ~30 sn'de bir sağlık mesajı (OTA durumu dahil)
 *
 * Çalıştır:
 *   npm run mock:device                              # 2 kanal, MAC A842E3123456
 *   npm run mock:device A8:42:E3:12:34:56            # iki noktalı da olur
 *   npm run mock:device A842E3123456 4               # 4 DALI kanalı (adres 0..3)
 *   npm run mock:device A842E3123456 2 ataturk-bulvari   # bölge topic'ini de dinle
 *   npm run mock:device A842E3123456 3 ataturk-bulvari --bin   # binary protokol v1
 *
 * `--bin`: yeni firmware gibi d4i_periodic, health ve HELLO'yu binary olarak
 * Meven:<MAC>/bin'e basar (lib/binproto encodeFrame). Komutlarda iki biçim
 * de kabul edilir (firmware geçiş dönemi): ilk bayt 0x01-0x1F ise binary
 * komut → binary COMMAND_ACK (/bin, u16 id aynen döner); `{` ise JSON komut →
 * JSON ack (/data). `--bin` olmadan eski firmware gibi davranır: binary komuta
 * "gecersiz json" döner.
 *
 * Not: adres 0 bilerek `d4i_supported:false` raporlar (sahadaki örnekle aynı) —
 * dashboard'un D4i'siz sürücüyü de doğru gösterdiğini test etmek için.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { effectByNumber, EFFECT_MAX_NUMBER, MORSE_TEXT_MAX } from "@/lib/effects";
import { MAX_ARC_LEVEL, MAX_CHANNEL } from "@/types/lighting";
import { encodeFrame, type FieldValue } from "@/lib/binproto/codec";
import { decodeFrame } from "@/lib/binproto/codec";
import {
  COMMAND_ACTIONS,
  COMMAND_RESULT_NOT_ENOUGH_LAMPS,
  COMMAND_RESULT_TEXTS,
  OTA_RESULTS,
  OTA_STATES,
  type EnumTable,
} from "@/lib/binproto/fields";

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BIN = process.argv.includes("--bin");
const MAC = (ARGS[0] ?? "A842E3123456")
  .replace(/[^0-9a-fA-F]/g, "")
  .toUpperCase();
const CH_COUNT = Math.max(1, Math.min(64, Number(ARGS[1] ?? 2) || 2));
const ZONE_SLUG = ARGS[2];

const T_CMD = `Meven:${MAC}/cmd`;
const T_ALL = "Meven:all/cmd";
const T_DATA = `Meven:${MAC}/data`;
const T_HEALTH = `Meven:${MAC}/health`;
const T_BIN = `Meven:${MAC}/bin`;
const TOPICS = [T_CMD, T_ALL, ...(ZONE_SLUG ? [`Meven:${ZONE_SLUG}/cmd`] : [])];

/** Kanal durumu — firmware gibi 0-254 DALI arc level tutulur. */
type ChannelState = { level: number; on: boolean; fx: number | null };
const channels = new Map<number, ChannelState>();
for (let i = 0; i < CH_COUNT; i++) channels.set(i, { level: 0, on: false, fx: null });

/** Mors efektinin son ayarlanan metni — komutta `text` yoksa bu tekrar çalınır. */
let morseText = "";

/** Firmware sürümü + OTA durumu (health mesajında yayınlanır). */
let firmwareVersion = "1.0.9";
const ota = {
  state: "idle",
  last_result: "up_to_date" as string,
  busy: false,
  last_target_version: null as string | null,
  last_message: null as string | null,
};
/** Commissioning servisi açılıştan bu kadar sonra hazır olur (firmware gibi). */
const SERVICE_READY_MS = 3000;
const bootAt = Date.now();
/** Firmware sınırı: cihaz başına en fazla 5 lamba, kanallar 0-4. */
const MAX_COMMISSION_CH = 4;

/**
 * Komutun action + id'si — yanıtta aynen geri gönderilir (firmware 1.0.9).
 * `binary`: komut binary geldiyse yanıt binary COMMAND_ACK olur (/bin).
 * `result`: binary pakette biçim hatası (yalnızca sonuç kodu döner).
 */
let current: { action?: unknown; id?: unknown; binary?: boolean } = {};

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-${MAC}-${Math.random().toString(16).slice(2, 8)}`,
});

/** Firmware'in hata metni → binary COMMAND_RESULT kodu (+ -10'un lamba sayıları). */
function resultCode(error: string): { code: number; needed?: number; available?: number } {
  const lamps = /en az (\d+) lamba ister, hatta (\d+) lamba var/.exec(error);
  if (lamps) return { code: COMMAND_RESULT_NOT_ENOUGH_LAMPS, needed: +lamps[1], available: +lamps[2] };
  const exact = Object.entries(COMMAND_RESULT_TEXTS).find(([, t]) => t === error);
  if (exact) return { code: Number(exact[0]) };
  // Mock'un eski metin varyantları (aralık yazımı farklı) → aynı kod.
  if (error.startsWith("dim icin")) return { code: -3 };
  if (error.startsWith("efekt icin") || error.startsWith("mors icin")) return { code: -4 };
  return { code: -5 };
}

function binaryAck(error?: string, onlyResult?: number) {
  const r = onlyResult !== undefined ? { code: onlyResult } : error ? resultCode(error) : { code: 0 };
  const action =
    onlyResult === undefined && typeof current.action === "string"
      ? Number(Object.entries(COMMAND_ACTIONS).find(([, n]) => n === current.action)?.[0] ?? 0) || undefined
      : undefined;
  publishBin("COMMAND_ACK", [
    ["COMMAND_ACTION", action],
    ["COMMAND_ID", onlyResult === undefined && typeof current.id === "number" && current.id > 0 ? current.id : undefined],
    ["COMMAND_RESULT", r.code],
    ["COMMAND_LAMPS_NEEDED", r.needed],
    ["COMMAND_LAMPS_AVAILABLE", r.available],
  ]);
  console.log(error || onlyResult ? `  → binary ack: HATA ${r.code}${error ? ` "${error}"` : ""}` : "  → binary ack: ok");
}

function ack(error?: string) {
  if (current.binary) return binaryAck(error);
  const echo = {
    ...(current.action !== undefined ? { action: current.action } : {}),
    ...(current.id !== undefined ? { id: current.id } : {}),
  };
  const payload = error ? { ...echo, status: "error", error } : { ...echo, status: "ok" };
  client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
  console.log(error ? `  → ack: HATA "${error}"` : "  → ack: ok");
}

/**
 * LED bloğu — iki senaryo birden test edilsin diye adrese göre değişir:
 *
 *  - TEK adres (1, 3, …): sürücü ölçümleri DOĞRULAYAMIYOR. `voltage_v`/
 *    `current_a`/`temperature_c` null gelir, yanlarında ham (`*_reported_*`) ve
 *    tahmini (`*_estimated_*`) değerler + sebep kodları durur. Sayaçlar tavana
 *    ulaşmış (`*_saturated` + `*_text: "253+"`). Sahadan gelen gerçek örnek.
 *  - ÇİFT adres (2, 4, …): eski/doğrulanmış biçim — düz `voltage_v` vb.
 *    Panelin geriye uyumu bununla görülür (≈ ve * işareti çıkmamalı).
 */
function ledBlock(address: number, on: boolean): Record<string, unknown> {
  const common = {
    bank_version: 1,
    fault_counts_are_historical: true,
    startup_count: 21998,
    operating_time_s: 762771,
    sample_coherent: true,
    measurement_state: on ? "on" : "off",
    general_failure: 0,
    short_circuit: 0,
    short_circuit_count: 10,
    open_circuit: 0,
    thermal_derating: 0,
    thermal_derating_count: 1,
    thermal_shutdown: 0,
    thermal_shutdown_count: 5,
  };

  if (address % 2 === 0) {
    return {
      ...common,
      voltage_v: 63.3,
      current_a: 0.592,
      temperature_c: 40 + Math.floor(Math.random() * 10),
      general_failure_count: 5,
      open_circuit_count: 12,
    };
  }

  return {
    ...common,
    current_reported_a: 0.592,
    current_available: true,
    voltage_reported_v: 1.8,
    voltage_estimated_v: 65.8783783783784,
    voltage_implausibility_reason: "load_power_current_mismatch",
    current_implausibility_reason: "load_power_current_mismatch",
    voltage_v: null,
    current_a: null,
    voltage_available: true,
    voltage_plausible: false,
    current_plausible: false,
    voltage_plausibility_checked: true,
    current_plausibility_checked: true,
    measurement_status: "load_power_current_mismatch",
    general_failure_count: 253,
    general_failure_count_saturated: true,
    general_failure_count_text: "253+",
    open_circuit_count: 253,
    open_circuit_count_saturated: true,
    open_circuit_count_text: "253+",
    temperature_raw: 53,
    temperature_reported_c: -7,
    temperature_implausibility_reason: "gear_temperature_mismatch",
    temperature_estimated_c: 53,
    temperature_estimation_reason: "suspected_missing_plus_60_offset",
    temperature_c: null,
    temperature_available: true,
    temperature_plausible: false,
    temperature_plausibility_checked: true,
    measurements_available: true,
    measurements_plausibility_checked: true,
    measurements_plausible: false,
  };
}

// ── Binary protokol v1 (--bin) ───────────────────────────────

type BinFields = Array<[string, FieldValue | undefined]>;

function publishBin(type: Parameters<typeof encodeFrame>[0], fields: BinFields): number {
  const frame = encodeFrame(type, fields);
  client.publish(T_BIN, Buffer.from(frame), { qos: type === "HEALTH" ? 2 : 0 });
  return frame.length;
}

const codeOf = (table: EnumTable, name: string | null | undefined) =>
  Number(Object.entries(table).find(([, v]) => v === name)?.[0] ?? 0);

/** "1.0.9" → 0x010009 */
const versionCode = (v: string | null) => {
  const [a, b, c] = (v ?? "").split(".").map(Number);
  return v ? (a << 16) | (b << 8) | c : undefined;
};

/**
 * JSON senaryosunun binary karşılığı: ham değerler (ölçek/maske kuralları
 * backend'de uygulanır). TEK adres doğrulanamayan ölçüm, ÇİFT adres
 * doğrulanmış ölçüm (bkz. ledBlock).
 */
function d4iBinFields(address: number, s: ChannelState, supported: boolean): BinFields {
  const fields: BinFields = [
    ["ADDRESS", address],
    ["ONLINE", 1],
    ["STATUS", s.on ? 4 : 0],
    ["CONTROL_GEAR_PRESENT", 255],
    // LAMP_FAILURE yazılmaz → JSON'da null (sürücü yanıtlamadı)
    ["LAMP_POWER_ON", s.on ? 255 : 0],
    ["ACTUAL_LEVEL", s.on ? s.level : 0],
    ["MAX_LEVEL", MAX_ARC_LEVEL],
    ["PHYSICAL_MIN_LEVEL", 157],
    ["MIN_LEVEL", 157],
    ["D4I_SUPPORTED", supported ? 1 : 0],
  ];
  if (!supported) return fields;

  const ratio = s.on ? s.level / MAX_ARC_LEVEL : 0;
  const verified = address % 2 === 0;
  fields.push(
    ["SAMPLE_COHERENT", 1],
    ["SAMPLE_STATE", s.on ? 1 : 2],
    ["BANK_206_LENGTH", 33],
    ["BANK_206_VERSION", 1],
    ["ENERGY_RAW_LOW", 9971068],
    ["ENERGY_RAW_HIGH", 0],
    ["ENERGY_SCALE", 0xfd], // 10^-3 → 9971.068 Wh
    ["POWER_RAW", Math.round(ratio * 473)],
    ["POWER_SCALE", 0xff], // 10^-1
    ["LOAD_POWER_RAW", Math.round(ratio * 39)],
    ["LOAD_POWER_SCALE", 0],
    ["LOAD_POWER_CHECK", 1],
    ["DRIVER_BANK_VERSION", 1],
    ["DRIVER_OPERATING_TIME_S", 1712344],
    ["DRIVER_STARTUP_COUNT", 87],
    ["DRIVER_INPUT_VOLTAGE", (229 + Math.floor(Math.random() * 4)) * 10],
    ["DRIVER_MAINS_FREQUENCY", 49],
    ["DRIVER_POWER_FACTOR", 100],
    ["DRIVER_TEMPERATURE", 50 + Math.floor(Math.random() * 6) + 60],
    ["DRIVER_OUTPUT_CURRENT_PERCENT", Math.round(ratio * 100)],
    ["DRIVER_GENERAL_FAILURE", 0],
    ["DRIVER_GENERAL_FAILURE_COUNT", 5],
    ["DRIVER_UNDERVOLTAGE_FAILURE", 0],
    ["DRIVER_UNDERVOLTAGE_FAILURE_COUNT", 4],
    ["DRIVER_OVERVOLTAGE_FAILURE", 0],
    ["DRIVER_OVERVOLTAGE_FAILURE_COUNT", 1],
    ["DRIVER_POWER_LIMITATION", 0],
    ["DRIVER_POWER_LIMITATION_COUNT", 0],
    ["DRIVER_THERMAL_DERATING", 0],
    ["DRIVER_THERMAL_DERATING_COUNT", 0],
    ["DRIVER_THERMAL_SHUTDOWN", 0],
    ["DRIVER_THERMAL_SHUTDOWN_COUNT", 0],
    ["LED_BANK_VERSION", 1],
    ["LED_STARTUP_COUNT", 21998],
    ["LED_OPERATING_TIME_S", 762771],
    ["LED_VOLTAGE", verified ? 633 : 18], // 63.3 V / 1.8 V (yanıltıcı ham)
    ["LED_CURRENT", 592],
    ["LED_TEMPERATURE", verified ? 100 + Math.floor(Math.random() * 10) : 53],
    ["LED_GENERAL_FAILURE", 0],
    ["LED_GENERAL_FAILURE_COUNT", verified ? 5 : 0xfd],
    ["LED_SHORT_CIRCUIT", 0],
    ["LED_SHORT_CIRCUIT_COUNT", 10],
    ["LED_OPEN_CIRCUIT", 0],
    ["LED_OPEN_CIRCUIT_COUNT", verified ? 12 : 0xfd],
    ["LED_THERMAL_DERATING", 0],
    ["LED_THERMAL_DERATING_COUNT", 1],
    ["LED_THERMAL_SHUTDOWN", 0],
    ["LED_THERMAL_SHUTDOWN_COUNT", 5],
    ["LED_MEASUREMENT_STATE", s.on ? 1 : 2],
    ["LED_VOLTAGE_PLAUSIBILITY_CHECKED", 1],
    ["LED_VOLTAGE_PLAUSIBLE", verified ? 1 : 0],
    ["LED_TEMPERATURE_PLAUSIBILITY_CHECKED", 1],
    ["LED_TEMPERATURE_PLAUSIBLE", verified ? 1 : 0],
  );
  if (!verified) {
    fields.push(
      ["LED_MEASUREMENT_STATUS", 10], // load_power_current_mismatch
      ["LED_VOLTAGE_ESTIMATED", 659],
      ["LED_TEMPERATURE_ESTIMATED", 53],
    );
  }
  return fields;
}

/** Health: bir-kezlik alanlar (IDF, derleme zamanı, ağ adı) bağlantı başına bir kez. */
let healthStaticSent = false;

function healthBinFields(): BinFields {
  const otaMessage: Record<string, number> = { checking: 6, downloading: 2, verifying: 1, updated: 8 };
  const fields: BinFields = [
    ["HEALTH_UPTIME_S", Math.round((Date.now() - bootAt) / 1000)],
    ["HEALTH_FREE_HEAP_BYTES", 182_000 + Math.floor(Math.random() * 4000)],
    ["HEALTH_FIRMWARE_VERSION", versionCode(firmwareVersion)],
    ["HEALTH_RESET_REASON", 1], // power_on
    ["HEALTH_MQTT_CONNECTED", 1],
    ["HEALTH_DROPPED_COMMANDS", 0],
    ["THREAD_ROLE", 2], // child
    ["THREAD_ATTACHED", 1],
    ["THREAD_PARENT_RSSI_AVG", -62],
    ["THREAD_PARENT_RSSI_LAST", -60],
    ["THREAD_RLOC16", 0x5c01],
    ["THREAD_PARTITION_ID", 0x1a2b3c4d],
    ["THREAD_CHANNEL", 15],
    ["THREAD_PAN_ID", 0x1234],
    ["OTA_STATE", codeOf(OTA_STATES, ota.state)],
    ["OTA_LAST_RESULT", codeOf(OTA_RESULTS, ota.last_result)],
    ["OTA_BUSY", ota.busy ? 1 : 0],
    ["OTA_LAST_TARGET_VERSION", versionCode(ota.last_target_version)],
    ["OTA_MESSAGE", otaMessage[ota.state] ?? 0],
    ["OTA_DOWNLOAD_PERCENT", ota.state === "downloading" ? 50 : undefined],
    ["NEIGHBOR_RLOC16", 0x5c00],
    ["NEIGHBOR_IS_CHILD", 0],
    ["NEIGHBOR_RSSI_AVG", -61],
  ];
  if (!healthStaticSent) {
    healthStaticSent = true;
    fields.push(
      ["HEALTH_IDF_VERSION", 0x050300], // v5.3
      ["HEALTH_BUILD_TIMESTAMP", Math.floor(Date.UTC(2026, 10, 2, 16, 25, 51) / 1000)],
      ["THREAD_NETWORK_NAME", "fener-1"],
    );
  }
  return fields;
}

/** Sürücü/LED sayaçlarıyla birlikte tek adresin D4i raporu. */
function publishD4i(address: number) {
  const s = channels.get(address);
  if (!s) return;
  const supported = address !== 0; // adres 0 → D4i'siz sürücü senaryosu

  if (BIN) {
    const size = publishBin("D4I_PERIODIC", d4iBinFields(address, s, supported));
    console.log(
      `  → [bin ${size} B] d4i_periodic ch${address}: ${s.on ? "açık" : "kapalı"} level=${s.on ? s.level : 0}${supported ? "" : " (D4i yok)"}`,
    );
    return;
  }

  const payload: Record<string, unknown> = {
    type: "d4i_periodic",
    address,
    online: true,
    status: {
      status: s.on ? 4 : 0, // bit2 = lamba yanıyor
      control_gear_present: 255,
      lamp_failure: null,
      lamp_power_on: s.on ? 255 : 0,
      actual_level: s.on ? s.level : 0,
      max_level: MAX_ARC_LEVEL,
      physical_min_level: 157,
      min_level: 157,
    },
    d4i_supported: supported,
  };

  if (supported) {
    const powerW = s.on ? Math.round((s.level / MAX_ARC_LEVEL) * 473) / 10 : 0;
    const loadW = s.on ? Math.round((s.level / MAX_ARC_LEVEL) * 39) : 0;

    payload.d4i = {
      energy: {
        raw_integer: "9971068",
        scale_raw: 253,
        scale_exponent: -3,
        value: 9971.068,
        unit: "Wh",
      },
      power: {
        raw_integer: Math.round(powerW * 10),
        scale_raw: 255,
        scale_exponent: -1,
        value: powerW,
        unit: "W",
      },
      driver: {
        bank_version: 1,
        fault_counts_are_historical: true,
        operating_time_s: 1712344,
        startup_count: 87,
        input_voltage_v: 229 + Math.floor(Math.random() * 4),
        mains_frequency_hz: 49,
        power_factor: 1,
        temperature_c: 50 + Math.floor(Math.random() * 6),
        output_current_percent: Math.round((s.level / MAX_ARC_LEVEL) * 100),
        general_failure: 0,
        general_failure_count: 5,
        undervoltage_failure: 0,
        undervoltage_failure_count: 4,
        overvoltage_failure: 0,
        overvoltage_failure_count: 1,
        power_limitation: 0,
        power_limitation_count: 0,
        thermal_derating: 0,
        thermal_derating_count: 0,
        thermal_shutdown: 0,
        thermal_shutdown_count: 0,
      },
      load_power: { value: loadW, unit: "W" },
      bank_206_raw_hex:
        "2000FF010055EE0055EE000BA393000BA3930012025000FD000A00FD0001000535",
      bank_206_length: 33,
      bank_206_version: 1,
      sample_coherent: true,
      sample_state: s.on ? "on" : "off",
      led: ledBlock(address, s.on),
    };
  }

  client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
  console.log(
    `  → d4i_periodic ch${address}: ${s.on ? "açık" : "kapalı"} level=${s.on ? s.level : 0}${supported ? "" : " (D4i yok)"}`,
  );
}

/** Firmware sınırı: aynı anda en fazla bu kadar kanalda efekt çalışabilir. */
const EFFECT_SLOTS = 4;

/**
 * Komutun hedeflediği adresler: `channel` YOKSA cihazdaki tüm lambalar, varsa
 * yalnızca o adres. Broadcast için ayrı bir değer (eski 255) yoktur — alanın
 * kendisi opsiyoneldir.
 */
function targets(channel?: number): number[] {
  return channel === undefined ? [...channels.keys()] : [channel];
}

/** Komut var olmayan bir DALI adresini hedefliyorsa true. */
function channelMissing(channel?: number): boolean {
  return channel !== undefined && !channels.has(channel);
}

/** `channel` ya hiç gelmez (tüm lambalar) ya da geçerli bir DALI adresidir. */
function validChannel(c: unknown): c is number | undefined {
  return (
    c === undefined ||
    (typeof c === "number" && Number.isInteger(c) && c >= 0 && c <= MAX_CHANNEL)
  );
}

function publishHealth() {
  if (BIN) {
    const size = publishBin("HEALTH", healthBinFields());
    console.log(`  → [bin ${size} B] health fw=${firmwareVersion} ota=${ota.state}`);
    return;
  }
  const payload = {
    type: "health",
    firmware_version: firmwareVersion,
    reset_reason: "ESP_RST_POWERON",
    ota: { ...ota },
  };
  client.publish(T_HEALTH, JSON.stringify(payload), { qos: 0 });
  console.log(`  → health fw=${firmwareVersion} ota=${ota.state}`);
}

/** OTA simülasyonu: yeni sürüm varmış gibi davranır, adım başına health yayınlar. */
function runOta() {
  const target = firmwareVersion.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  const steps: Array<[number, () => void]> = [
    [500, () => Object.assign(ota, { state: "checking", busy: true })],
    [2000, () => Object.assign(ota, { state: "downloading", last_target_version: target })],
    [6000, () => Object.assign(ota, { state: "verifying" })],
    [8000, () => Object.assign(ota, { state: "updated", last_result: "updated", busy: false })],
    // "yeniden başladı": yeni sürüm, durum idle
    [11000, () => {
      firmwareVersion = target;
      Object.assign(ota, { state: "idle", last_message: null });
    }],
  ];
  for (const [ms, fn] of steps) {
    setTimeout(() => {
      fn();
      publishHealth();
    }, ms);
  }
}

client.on("connect", () => {
  console.log(`✓ HiveMQ bağlandı — sanal cihaz ${MAC} (${CH_COUNT} kanal)${BIN ? " · binary protokol v1" : ""}`);
  healthStaticSent = false; // yeni bağlantı: bir-kezlik health alanları tekrar gider
  client.subscribe(TOPICS, { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor:\n    ${TOPICS.join("\n    ")}`);
    console.log("\nDashboard'dan komut gönder → burada görünecek, yanıtı dashboard'a dönecek.\n");
    if (BIN) publishBin("HELLO", []);
    for (const ch of channels.keys()) publishD4i(ch);
    publishHealth();
  });
});

client.on("message", (topic, raw) => {
  let cmd: {
    action?: string;
    value?: number;
    number?: number;
    channel?: number;
    text?: string;
    id?: string | number;
  };
  if (BIN && raw.length > 0 && raw[0] >= 0x01 && raw[0] <= 0x1f) {
    // Binary komut (protokol v1). Bozuk pakette action/id güvenilmez: yalnızca sonuç.
    current = { binary: true };
    const frame = decodeFrame(raw);
    if (!frame.ok) {
      console.warn(`◀ bozuk binary komut (${frame.reason}: ${frame.detail})`);
      return binaryAck(undefined, frame.reason === "CRC" ? -15 : frame.reason === "VERSION" ? -16 : -17);
    }
    if (frame.typeName !== "COMMAND") return binaryAck(undefined, -17);
    const f = new Map(frame.fields);
    const num = (k: string) => (typeof f.get(k) === "number" ? (f.get(k) as number) : undefined);
    const code = num("COMMAND_ACTION");
    const ch = num("COMMAND_CHANNEL");
    cmd = {
      action: code === undefined ? undefined : (COMMAND_ACTIONS[code] ?? `bilinmeyen-${code}`),
      value: num("COMMAND_VALUE"),
      number: num("COMMAND_EFFECT_NUMBER"),
      channel: ch === 255 ? undefined : ch, // 255 = broadcast
      text: typeof f.get("COMMAND_EFFECT_TEXT") === "string" ? (f.get("COMMAND_EFFECT_TEXT") as string) : undefined,
      id: num("COMMAND_ID"),
    };
    current = { action: cmd.action, id: cmd.id, binary: true };
    console.log(`◀ binary komut (${raw.length} B, id ${cmd.id ?? "yok"})`);
  } else {
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      console.warn("◀ geçersiz JSON");
      current = {}; // geçersiz JSON'da action/id geri gelmez
      return ack("gecersiz json");
    }
    current = { action: cmd.action, id: cmd.id };
  }

  const via = topic === T_ALL ? "all" : topic === T_CMD ? "MAC" : "bölge";
  const { action, value, number, channel, text } = cmd;
  if (action === undefined) return ack("action alani yok");
  if (typeof action !== "string") return ack("action string degil");
  const scope = channel === undefined ? "tüm kanallar" : `ch${channel}`;

  if (action === "on" || action === "off") {
    if (!validChannel(channel)) return ack("bilinmeyen action");
    if (channelMissing(channel)) {
      console.warn(`◀ ${action} reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }
    for (const a of targets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.on = action === "on";
      s.fx = null;
      if (s.on && s.level === 0) s.level = MAX_ARC_LEVEL;
    }
    console.log(`◀ ${action} (${via}, ${scope})`);
    ack();
    for (const a of targets(channel)) publishD4i(a);
    return;
  }

  if (action === "dim") {
    if (typeof value !== "number" || value < 0 || value > 100 || !validChannel(channel)) {
      console.warn(`◀ dim reddedildi (value=${value} channel=${channel})`);
      return ack("dim icin value (0..100) ve channel (0..63) gerekli");
    }
    if (channelMissing(channel)) {
      console.warn(`◀ dim reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }
    for (const a of targets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.level = Math.round((value / 100) * MAX_ARC_LEVEL);
      // DALI: seviye 0 = lamba söner (firmware on/off'u da dim 100/0 olarak alır).
      s.on = value > 0;
      s.fx = null;
    }
    console.log(`◀ dim ${value} (${via}, ${scope})`);
    ack();
    for (const a of targets(channel)) publishD4i(a);
    return;
  }

  if (action === "efekt") {
    if (typeof number !== "number" || number < 0 || number > EFFECT_MAX_NUMBER) {
      console.warn(`◀ efekt reddedildi (number=${number})`);
      return ack("efekt icin number (0..14) ve channel (0..63) gerekli");
    }

    const fx = effectByNumber(number);

    // Tüm hattı süren efektler (Chase) kanal KABUL ETMEZ ve asgari lamba ister.
    if (fx?.allLamps) {
      if (channel !== undefined) {
        console.warn(`◀ ${fx.label} reddedildi: channel gönderildi (${channel})`);
        return ack("chase efekti tum lambalari surer, channel gondermeyin");
      }
      const min = fx.minLamps ?? 2;
      if (channels.size < min) {
        console.warn(`◀ ${fx.label} reddedildi: ${channels.size} lamba yetersiz`);
        return ack(`bu efekt en az ${min} lamba ister, hatta ${channels.size} lamba var`);
      }
    } else if (!validChannel(channel)) {
      console.warn(`◀ efekt reddedildi (channel=${channel})`);
      return ack("efekt icin number (0..14) ve channel (0..63) gerekli");
    }

    // Hattaki gerçek adres mi? (broadcast hariç)
    if (channel !== undefined && channelMissing(channel)) {
      console.warn(`◀ efekt reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }

    // Aynı anda en fazla 4 kanalda efekt çalışabilir (firmware slot sınırı).
    const wouldRun = new Set([...channels.entries()].filter(([, s]) => s.fx).map(([a]) => a));
    if (number > 0) for (const a of targets(channel)) wouldRun.add(a);
    if (wouldRun.size > EFFECT_SLOTS) {
      console.warn(`◀ efekt reddedildi: slot dolu (${wouldRun.size}/${EFFECT_SLOTS})`);
      return ack("efekt baslatilamadi (bos slot yok veya bellek yetersiz)");
    }

    // Mors: `text` opsiyonel — gelmezse son ayarlanan metin çalınır.
    if (fx?.needsText && text !== undefined) {
      if (typeof text !== "string" || text.length > MORSE_TEXT_MAX || !/^[A-Z0-9 ]*$/.test(text)) {
        console.warn(`◀ mors metni reddedildi: ${JSON.stringify(text)}`);
        return ack("mors icin text (harf/rakam/bosluk, en fazla 32 karakter) gerekli");
      }
      morseText = text;
    }
    for (const a of targets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.fx = number === 0 ? null : number;
      if (number > 0) s.on = true;
    }
    const suffix = fx?.needsText ? ` "${morseText || "(metin ayarlanmadı)"}"` : "";
    console.log(`◀ efekt #${number} ${fx?.label ?? "durdur"}${suffix} (${via}, ${scope})`);
    ack();
    for (const a of targets(channel)) publishD4i(a);
    return;
  }

  if (action === "commission") {
    if (Date.now() - bootAt < SERVICE_READY_MS) {
      return ack("commissioning servisi henuz hazir degil");
    }
    console.log(`◀ commission (${via}) — DALI taraması`);
    ack();
    // Boş bir kanala "yeni lamba" yerleştir (0-4); taramadan sonra raporlanır.
    let added: number | undefined;
    for (let c = 0; c <= MAX_COMMISSION_CH; c++) {
      if (!channels.has(c)) {
        channels.set(c, { level: 0, on: false, fx: null });
        added = c;
        break;
      }
    }
    setTimeout(() => {
      console.log(added === undefined ? "  tarama bitti: yeni lamba yok" : `  tarama bitti: yeni lamba ch${added}`);
      for (const ch of channels.keys()) publishD4i(ch);
    }, 1500);
    return;
  }

  if (action === "ota_check") {
    if (Date.now() - bootAt < SERVICE_READY_MS) return ack("ota servisi henuz hazir degil");
    console.log(`◀ ota_check (${via})`);
    ack();
    if (!ota.busy) runOta();
    return;
  }

  if (action === "d4i_read") {
    if (typeof channel !== "number" || channel < 0 || channel > MAX_CHANNEL) {
      console.warn(`◀ d4i_read reddedildi (channel=${channel})`);
      return ack("d4i_read icin channel (0..63) gerekli");
    }
    console.log(`◀ d4i_read (${via}, ch${channel})`);
    ack();
    publishD4i(channel);
    return;
  }

  console.warn(`◀ bilinmeyen action: ${action}`);
  ack("bilinmeyen action");
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

// Periyodik rapor — her adres için sırayla.
setInterval(() => {
  for (const ch of channels.keys()) publishD4i(ch);
  publishHealth();
}, 30000);

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
