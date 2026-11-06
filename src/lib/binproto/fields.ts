/**
 * Binary MQTT protokolü v1: alan tablosu ve değer enum'ları.
 *
 * SÖZLEŞMENİN KAYNAĞI firmware reposundaki
 * `components/msg_codec/include/msg_fields.h` (alan/enum kodları) ve
 * `src/msg_fields.c` (boy tablosu). Bu dosya onun TypeScript kopyasıdır —
 * kaynak: "MQTT Binary Protokolü v1" dokümanı, rev 1.0 (3 Kasım 2026),
 * `firmware/MQTT-BINARY-PROTOKOL.html`.
 *
 * ⚠ KURAL: firmware yeni bir alan eklediğinde ÖNCE bu tablo güncellenip
 * deploy edilir, SONRA cihazlara OTA yapılır. Tanımsız alan kodu taşıyan paket
 * tamamen reddedilir (dashboard o cihazın verisini göremez; admin kartında
 * kırmızı uyarı çıkar). Mevcut bir kodun boyu/anlamı asla değişmez.
 *
 * Saf modül: sunucu ve istemci (ve tsx betikleri) kullanabilir.
 */

export const PROTOCOL_VERSION = 0x01;
/** LoRa aydınlatma gateway'inin ayrı protokolü (ilk bayt 0x02) — henüz desteklenmiyor. */
export const LORA_PROTOCOL_VERSION = 0x02;

export type FieldKind = "u8" | "u16" | "u24" | "u32" | "i8" | "i32" | "bytes" | "list" | "text";

export interface FieldDef {
  code: number;
  /** `MSG_FIELD_` öneki olmadan (Python köprüsüyle aynı ad). */
  name: string;
  /** Değerin bayt sayısı; 0 = değişken (önce 1 bayt uzunluk). */
  size: number;
  kind: FieldKind;
}

const u8 = (code: number, name: string): FieldDef => ({ code, name, size: 1, kind: "u8" });
const i8 = (code: number, name: string): FieldDef => ({ code, name, size: 1, kind: "i8" });
const u16 = (code: number, name: string): FieldDef => ({ code, name, size: 2, kind: "u16" });
const u24 = (code: number, name: string): FieldDef => ({ code, name, size: 3, kind: "u24" });
const u32 = (code: number, name: string): FieldDef => ({ code, name, size: 4, kind: "u32" });
const i32 = (code: number, name: string): FieldDef => ({ code, name, size: 4, kind: "i32" });
const vari = (code: number, name: string, kind: "bytes" | "list" | "text"): FieldDef => ({
  code,
  name,
  size: 0,
  kind,
});

export const FIELD_DEFS: readonly FieldDef[] = [
  // Ortak
  u8(0x01, "TYPE"),
  u8(0x02, "ADDRESS"),
  u8(0x03, "ONLINE"),
  u8(0x04, "ERROR"),
  // DALI durum sorguları
  u8(0x10, "STATUS"),
  u8(0x11, "CONTROL_GEAR_PRESENT"),
  u8(0x12, "LAMP_FAILURE"),
  u8(0x13, "LAMP_POWER_ON"),
  u8(0x14, "ACTUAL_LEVEL"),
  u8(0x15, "MAX_LEVEL"),
  u8(0x16, "PHYSICAL_MIN_LEVEL"),
  u8(0x17, "MIN_LEVEL"),
  // D4i genel
  u8(0x20, "D4I_SUPPORTED"),
  u8(0x21, "BANK"),
  u8(0x22, "BANK_OK"),
  u16(0x23, "BANK_LENGTH"),
  vari(0x24, "BANK_RAW", "bytes"),
  u8(0x25, "LAST_BANK"),
  u8(0x26, "DECODE_OK"),
  u8(0x27, "DECODE_ERROR"),
  vari(0x28, "READ_ERRORS", "list"),
  vari(0x29, "DECODE_ERRORS", "list"),
  u8(0x2a, "SAMPLE_COHERENT"),
  u8(0x2b, "SAMPLE_STATE"),
  u8(0x2c, "SAMPLE_STATUS"),
  u16(0x2d, "BANK_206_LENGTH"),
  u8(0x2e, "BANK_206_VERSION"),
  // Enerji ve güç (bank 202, 204)
  u32(0x30, "ENERGY_RAW_LOW"),
  u16(0x31, "ENERGY_RAW_HIGH"),
  u8(0x32, "ENERGY_SCALE"),
  u32(0x33, "POWER_RAW"),
  u8(0x34, "POWER_SCALE"),
  u32(0x35, "LOAD_POWER_RAW"),
  u8(0x36, "LOAD_POWER_SCALE"),
  u8(0x37, "LOAD_POWER_CHECK"),
  // Sürücü (bank 205)
  u8(0x40, "DRIVER_BANK_VERSION"),
  u32(0x41, "DRIVER_OPERATING_TIME_S"),
  u24(0x42, "DRIVER_STARTUP_COUNT"),
  u16(0x43, "DRIVER_INPUT_VOLTAGE"),
  u8(0x44, "DRIVER_MAINS_FREQUENCY"),
  u8(0x45, "DRIVER_POWER_FACTOR"),
  u8(0x46, "DRIVER_TEMPERATURE"),
  u8(0x47, "DRIVER_OUTPUT_CURRENT_PERCENT"),
  u8(0x48, "DRIVER_GENERAL_FAILURE"),
  u8(0x49, "DRIVER_GENERAL_FAILURE_COUNT"),
  u8(0x4a, "DRIVER_UNDERVOLTAGE_FAILURE"),
  u8(0x4b, "DRIVER_UNDERVOLTAGE_FAILURE_COUNT"),
  u8(0x4c, "DRIVER_OVERVOLTAGE_FAILURE"),
  u8(0x4d, "DRIVER_OVERVOLTAGE_FAILURE_COUNT"),
  u8(0x4e, "DRIVER_POWER_LIMITATION"),
  u8(0x4f, "DRIVER_POWER_LIMITATION_COUNT"),
  u8(0x50, "DRIVER_THERMAL_DERATING"),
  u8(0x51, "DRIVER_THERMAL_DERATING_COUNT"),
  u8(0x52, "DRIVER_THERMAL_SHUTDOWN"),
  u8(0x53, "DRIVER_THERMAL_SHUTDOWN_COUNT"),
  // LED (bank 206)
  u8(0x60, "LED_BANK_VERSION"),
  u24(0x61, "LED_STARTUP_COUNT"),
  u32(0x62, "LED_OPERATING_TIME_S"),
  u16(0x63, "LED_VOLTAGE"),
  u16(0x64, "LED_CURRENT"),
  u8(0x65, "LED_TEMPERATURE"),
  u8(0x66, "LED_GENERAL_FAILURE"),
  u8(0x67, "LED_GENERAL_FAILURE_COUNT"),
  u8(0x68, "LED_SHORT_CIRCUIT"),
  u8(0x69, "LED_SHORT_CIRCUIT_COUNT"),
  u8(0x6a, "LED_OPEN_CIRCUIT"),
  u8(0x6b, "LED_OPEN_CIRCUIT_COUNT"),
  u8(0x6c, "LED_THERMAL_DERATING"),
  u8(0x6d, "LED_THERMAL_DERATING_COUNT"),
  u8(0x6e, "LED_THERMAL_SHUTDOWN"),
  u8(0x6f, "LED_THERMAL_SHUTDOWN_COUNT"),
  u8(0x70, "LED_MEASUREMENT_STATE"),
  u8(0x71, "LED_MEASUREMENT_STATUS"),
  u8(0x72, "LED_VOLTAGE_PLAUSIBILITY_CHECKED"),
  u8(0x73, "LED_VOLTAGE_PLAUSIBLE"),
  u8(0x74, "LED_VOLTAGE_CORRECTED"),
  u16(0x75, "LED_VOLTAGE_ESTIMATED"),
  u8(0x76, "LED_TEMPERATURE_PLAUSIBILITY_CHECKED"),
  u8(0x77, "LED_TEMPERATURE_PLAUSIBLE"),
  u8(0x78, "LED_TEMPERATURE_ESTIMATED"),
  // Commissioning sonucu
  u8(0x90, "COMMISSION_TRIGGER"),
  u8(0x91, "COMMISSION_COUNT"),
  vari(0x92, "COMMISSION_ADDRESSES", "list"),
  vari(0x93, "COMMISSION_RECHECKED", "list"),
  i8(0x94, "COMMISSION_RX_IDLE_LEVEL"),
  u8(0x95, "COMMISSION_RX_IDLE_CHANGED"),
  u32(0x96, "COMMISSION_DURATION_MS"),
  // Komut ve ack
  u8(0xa0, "COMMAND_ACTION"),
  u16(0xa1, "COMMAND_ID"),
  u8(0xa2, "COMMAND_CHANNEL"),
  u8(0xa3, "COMMAND_VALUE"),
  u8(0xa4, "COMMAND_EFFECT_NUMBER"),
  vari(0xa5, "COMMAND_EFFECT_TEXT", "text"),
  i8(0xa6, "COMMAND_RESULT"),
  u8(0xa7, "COMMAND_LAMPS_NEEDED"),
  u8(0xa8, "COMMAND_LAMPS_AVAILABLE"),
  // Health
  u32(0xb0, "HEALTH_UPTIME_S"),
  u32(0xb1, "HEALTH_FREE_HEAP_BYTES"),
  u24(0xb2, "HEALTH_FIRMWARE_VERSION"),
  u24(0xb3, "HEALTH_IDF_VERSION"),
  u32(0xb4, "HEALTH_BUILD_TIMESTAMP"),
  u8(0xb6, "HEALTH_RESET_REASON"),
  u8(0xb7, "HEALTH_MQTT_CONNECTED"),
  u32(0xb8, "HEALTH_DROPPED_COMMANDS"),
  // Thread ve komşular
  u8(0xc0, "THREAD_ROLE"),
  u8(0xc1, "THREAD_ATTACHED"),
  i8(0xc2, "THREAD_PARENT_RSSI_AVG"),
  i8(0xc3, "THREAD_PARENT_RSSI_LAST"),
  u8(0xc4, "THREAD_PARENT_LINK_QUALITY_IN"),
  u8(0xc5, "THREAD_PARENT_LINK_QUALITY_OUT"),
  u16(0xc6, "THREAD_RLOC16"),
  u32(0xc7, "THREAD_PARTITION_ID"),
  u8(0xc8, "THREAD_CHANNEL"),
  u16(0xc9, "THREAD_PAN_ID"),
  vari(0xca, "THREAD_NETWORK_NAME", "text"),
  u16(0xcb, "THREAD_PARENT_CHANGES"),
  u16(0xcc, "THREAD_PARTITION_ID_CHANGES"),
  u16(0xcd, "THREAD_ATTACH_ATTEMPTS"),
  u16(0xd0, "NEIGHBOR_RLOC16"),
  u8(0xd1, "NEIGHBOR_IS_CHILD"),
  i8(0xd2, "NEIGHBOR_RSSI_AVG"),
  i8(0xd3, "NEIGHBOR_RSSI_LAST"),
  u8(0xd4, "NEIGHBOR_LINK_MARGIN"),
  u8(0xd5, "NEIGHBOR_LINK_QUALITY_IN"),
  // OTA
  u8(0xe0, "OTA_STATE"),
  u8(0xe1, "OTA_LAST_RESULT"),
  u8(0xe2, "OTA_BUSY"),
  u32(0xe3, "OTA_CHECK_COUNT"),
  u32(0xe4, "OTA_LAST_CHECK_UPTIME_S"),
  u32(0xe5, "OTA_LAST_SUCCESS_UPTIME_S"),
  u24(0xe6, "OTA_LAST_TARGET_VERSION"),
  u8(0xe7, "OTA_MESSAGE"),
  u8(0xe8, "OTA_DOWNLOAD_PERCENT"),
  u32(0xe9, "OTA_DOWNLOAD_BYTES"),
  u32(0xea, "OTA_DOWNLOAD_TOTAL_BYTES"),
  i32(0xeb, "OTA_LAST_ERROR"),
];

export const FIELDS_BY_CODE: ReadonlyMap<number, FieldDef> = new Map(
  FIELD_DEFS.map((f) => [f.code, f]),
);
export const FIELDS_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(
  FIELD_DEFS.map((f) => [f.name, f]),
);

// ── Değer enum'ları ──────────────────────────────────────────
// JSON karşılığı, aksi belirtilmedikçe enum adının küçük harfli hâlidir.
// Bilinmeyen değer paketi reddettirmez; "unknown" yazılır (bkz. toJson enumName).

export type EnumTable = Readonly<Record<number, string>>;

/** msg_type_t · TYPE */
export const MESSAGE_TYPES = {
  D4I_PERIODIC: 1,
  DALI_STATUS: 2,
  D4I_BANK: 3,
  COMMISSION_RESULT: 4,
  HEALTH: 5,
  COMMAND_ACK: 6,
  HELLO: 7,
  COMMAND: 8,
} as const;
export type MessageTypeName = keyof typeof MESSAGE_TYPES;

export const MESSAGE_TYPE_NAMES: EnumTable = Object.fromEntries(
  Object.entries(MESSAGE_TYPES).map(([name, code]) => [code, name]),
);

/** msg_error_t · ERROR */
export const ERRORS: EnumTable = {
  1: "no_response",
  2: "bank0_unreadable",
  3: "bank_not_implemented",
};

/** msg_decode_error_t — JSON metni enum adından uzun olan tek değer. */
export const DECODE_ERRORS: EnumTable = {
  1: "unsupported_bank_layout_or_version",
};

/** msg_measurement_state_t */
export const MEASUREMENT_STATES: EnumTable = {
  0: "unknown",
  1: "on",
  2: "off",
  3: "transitioning",
};

/** msg_measurement_status_t */
export const MEASUREMENT_STATUSES: EnumTable = {
  1: "local_level_command_during_sample",
  2: "snapshot_query_failed",
  3: "operating_state_changed_during_sample",
  4: "fade_in_progress",
  5: "status_level_mismatch",
  6: "light_source_off",
  7: "operating_state_unknown",
  8: "plausibility_context_unavailable",
  9: "voltage_corrected_16bit_mv_wrap",
  10: "load_power_current_mismatch",
  11: "input_power_current_mismatch",
  12: "current_too_low_for_check",
  13: "power_reference_unavailable",
};

/** msg_commission_trigger_t */
export const COMMISSION_TRIGGERS: EnumTable = {
  0: "unknown",
  1: "boot",
  2: "mqtt",
  3: "auto",
};

/** msg_command_action_t */
export const COMMAND_ACTIONS: EnumTable = {
  1: "dim",
  2: "efekt",
  3: "d4i_read",
  4: "commission",
  5: "ota_check",
};

/**
 * msg_command_result_t → komut ack'inin JSON `error` metni. Metinler
 * firmware'dekiyle birebir aynı (ASCII); `lib/deviceErrors.ts` bunları okur.
 * -10'un metni LAMPS_NEEDED / LAMPS_AVAILABLE alanlarından üretilir.
 */
export const COMMAND_RESULT_TEXTS: EnumTable = {
  [-1]: "gecersiz json",
  [-2]: "action alani yok",
  [-3]: "dim icin value (0..100) ve channel (0..63 veya 255) gerekli",
  [-4]: "efekt icin number (0..28) ve channel (0..63 veya 255) gerekli",
  [-5]: "bilinmeyen action",
  [-6]: "d4i_read icin channel (0..63) gerekli",
  [-7]: "bu channel DALI hattinda bulunamadi",
  [-8]: "chase efekti tum lambalari surer, channel gondermeyin",
  [-9]: "efekt baslatilamadi (bos slot yok veya bellek yetersiz)",
  [-11]: "commissioning servisi henuz hazir degil",
  [-12]: "ota servisi henuz hazir degil",
  [-13]: "d4i rapor servisi henuz hazir degil",
  [-14]: "cihaz mesgul, komut kuyrugu dolu",
  [-15]: "crc hatali, paket islenmedi",
  [-16]: "desteklenmeyen protokol versiyonu",
  [-17]: "paket bicimi bozuk",
  [-22]: "action string degil",
};
export const COMMAND_RESULT_NOT_ENOUGH_LAMPS = -10;

/** msg_reset_reason_t (ESP-IDF esp_reset_reason_t sırasıyla aynı). */
export const RESET_REASONS: EnumTable = {
  0: "unknown",
  1: "power_on",
  2: "external_pin",
  3: "software",
  4: "panic",
  5: "int_wdt",
  6: "task_wdt",
  7: "wdt",
  8: "deep_sleep",
  9: "brownout",
  10: "sdio",
  11: "usb",
  12: "jtag",
  13: "efuse",
  14: "power_glitch",
  15: "cpu_lockup",
};

/** msg_thread_role_t */
export const THREAD_ROLES: EnumTable = {
  0: "disabled",
  1: "detached",
  2: "child",
  3: "router",
  4: "leader",
};

/** msg_ota_state_t */
export const OTA_STATES: EnumTable = {
  0: "idle",
  1: "waiting_network",
  2: "checking",
  3: "downloading",
  4: "verifying",
  5: "updated",
  6: "failed",
};

/** msg_ota_result_t */
export const OTA_RESULTS: EnumTable = {
  0: "up_to_date",
  1: "blocked",
  2: "updated",
  3: "failed",
};

/**
 * msg_ota_message_t → `ota.last_message` metni. 7 (ERROR) metin değil:
 * OTA_LAST_ERROR'daki esp_err_t'nin ESP-IDF adı yazılır (bkz. espErr.ts).
 */
export const OTA_MESSAGE_TEXTS: EnumTable = {
  0: "",
  1: "Firmware dogrulaniyor",
  2: "Firmware indiriliyor",
  3: "Ag bekleniyor",
  4: "Ag yok, ertelendi",
  5: "Varsayilan URL, atlandi",
  6: "Metadata kontrol ediliyor",
  8: "Guncelleme tamamlandi",
  9: "Bloklu surum atlandi",
  10: "Firmware guncel",
};
export const OTA_MESSAGE_ERROR = 7;
