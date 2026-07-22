import { z } from "zod";
import { EFFECT_MAX_NUMBER, MORSE_TEXT_MAX, normalizeMorseText } from "@/lib/effects";

/**
 * MQTT payload kontratı — CLAUDE.md "Payload Formatları" bölümünün tek
 * kaynağı. LoRa geçişinde transport binary olur ama bu semantik korunur.
 */

export const ACTIONS = ["on", "off", "dim", "efekt"] as const;
export type Action = (typeof ACTIONS)[number];

// Kanal (DALI lambası) no: bir ESP'ye bağlı bağımsız aydınlatma adresi.
// 0-63 (DALI kısa adres). Komutta yoksa "tüm cihaz" (bütün lambalar) hedeflenir.
export const MAX_CHANNEL = 63;

// DALI broadcast adresi. Firmware `dim`/`efekt` komutlarında `channel`'ı ZORUNLU
// tutar ("... ve channel (0..63 veya 255) gerekli"); tüm lambaları hedeflemek
// için 255 gönderilir. API kontratında `channel` yokluğu = tüm cihaz demek
// olmaya devam eder; 255'e çeviri yalnızca MQTT payload'ı üretilirken yapılır.
export const BROADCAST_CHANNEL = 255;

// ── DALI arc level ↔ yüzde ───────────────────────────────────
// Cihaz parlaklığı 0-254 DALI seviyesi olarak raporlar (`status.actual_level`),
// dashboard ve komut kontratı ise 0-100 yüzde kullanır. Firmware dim değerini
// doğrusal ölçeklediği için dönüşüm de doğrusaldır — eğri değişirse tek yer
// burasıdır.
export const MAX_ARC_LEVEL = 254;

export function levelToPercent(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / MAX_ARC_LEVEL) * 100)));
}

export function percentToLevel(percent: number): number {
  return Math.max(0, Math.min(MAX_ARC_LEVEL, Math.round((percent / 100) * MAX_ARC_LEVEL)));
}

// ── Command (Backend → ESP32) ────────────────────────────────
// Yayınlanan komut payload'ı yalın: { action, value?, channel } veya
// { action:"efekt", number, channel }. `channel` 0-63 tek lambayı, 255 tüm
// lambaları hedefler (bkz. BROADCAST_CHANNEL).
export const commandPayloadSchema = z.object({
  action: z.enum(ACTIONS),
  value: z.number().int().min(0).max(100).optional(),
  number: z.number().int().min(0).max(EFFECT_MAX_NUMBER).optional(), // efekt no (0 = durdur)
  channel: z
    .number()
    .int()
    .refine((c) => (c >= 0 && c <= MAX_CHANNEL) || c === BROADCAST_CHANNEL, {
      message: `channel 0-${MAX_CHANNEL} arası ya da ${BROADCAST_CHANNEL} (broadcast) olmalı`,
    })
    .optional(),
  // Mors efektinin (no 22) çalacağı metin. Gönderilmezse cihaz son ayarlanan
  // metni tekrar çalar — bu yüzden boş metin gönderilmez, alan hiç konmaz.
  text: z.string().max(MORSE_TEXT_MAX).optional(),
});
export type CommandPayload = z.infer<typeof commandPayloadSchema>;

// ── Data (ESP32 → Backend, Meven:<MAC>/data) ─────────────────
// Tek kanal (lamba) durumu — çok-lamba cihazlar `channels` dizisinde raporlar.
export const channelStatusSchema = z.object({
  ch: z.number().int().min(0).max(MAX_CHANNEL),
  brightness: z.number().int().min(0).max(100).optional(),
  relayStatus: z.enum(["on", "off"]).optional(),
  status: z.enum(["ok", "error"]).optional(),
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const dataPayloadSchema = z.object({
  deviceId: z.string(), // MAC (iki noktasız)
  // Cihaz-seviyesi (tek-lamba / geriye uyum) alanlar:
  brightness: z.number().int().min(0).max(100).optional(),
  relayStatus: z.enum(["on", "off"]).optional(),
  temperature: z.number().optional(),
  rssi: z.number().int().optional(),
  status: z.enum(["ok", "error"]),
  // Çok-lamba (DALI) cihazlar için kanal başına durum:
  channels: z.array(channelStatusSchema).optional(),
});
export type DataPayload = z.infer<typeof dataPayloadSchema>;

// ── D4i periyodik rapor (ESP32 → Backend) ────────────────────
// Cihaz her DALI adresi (lamba) için ayrı bir mesaj yayınlar. Payload'da
// `deviceId` YOKTUR — MAC topic'ten okunur (bkz. lib/topics.ts macFromDataTopic).

/**
 * DALI sorgu yanıtı üç durumlu: 255 (evet), 0 (hayır), null (cihaz yanıtlamadı).
 * `daliFlag` ham değeri korur; yoruma `flagToBool` ile geçilir.
 */
const daliFlag = z.union([z.number().int(), z.boolean()]).nullable().optional();

export function flagToBool(v: number | boolean | null | undefined): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v !== "number") return undefined;
  return v !== 0;
}

/** Ölçekli D4i büyüklüğü: raw_integer × 10^scale_exponent = value (unit). */
const d4iMetricSchema = z.object({
  raw_integer: z.union([z.string(), z.number()]).nullable().optional(),
  scale_exponent: z.number().nullable().optional(),
  value: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
});

const num = z.number().nullable().optional();

export const d4iPeriodicSchema = z.object({
  type: z.literal("d4i_periodic"),
  address: z.number().int().min(0).max(MAX_CHANNEL), // DALI kısa adres = kanal (lamba) no
  online: z.boolean().optional(),
  status: z
    .object({
      status: num, // DALI durum baytı (bit1 lamba arızası, bit2 lamba yanıyor)
      control_gear_present: daliFlag,
      lamp_failure: daliFlag,
      lamp_power_on: daliFlag,
      actual_level: num, // 0-254 arc level
      max_level: num,
      physical_min_level: num,
      min_level: num,
    })
    .optional(),
  d4i_supported: z.boolean().optional(),
  d4i: z
    .object({
      energy: d4iMetricSchema.optional(),
      power: d4iMetricSchema.optional(),
      driver: z
        .object({
          operating_time_s: num,
          startup_count: num,
          input_voltage_v: num,
          mains_frequency_hz: num,
          power_factor: num,
          temperature_c: num,
          output_current_percent: num,
        })
        .optional(),
      led: z
        .object({
          startup_count: num,
          operating_time_s: num,
          voltage_v: num,
          current_a: num,
          temperature_c: num,
        })
        .optional(),
    })
    .optional(),
});
export type D4iPeriodic = z.infer<typeof d4iPeriodicSchema>;

/** DALI durum baytı bitleri (IEC 62386 QUERY STATUS). */
const STATUS_BIT_GEAR_FAILURE = 0x01;
const STATUS_BIT_LAMP_FAILURE = 0x02;
const STATUS_BIT_LAMP_POWER_ON = 0x04;

/** D4i raporundan lambanın açık olup olmadığını türetir (bilinmiyorsa undefined). */
export function d4iIsOn(d: D4iPeriodic): boolean | undefined {
  const s = d.status;
  if (!s) return undefined;
  const flag = flagToBool(s.lamp_power_on);
  if (typeof flag === "boolean") return flag;
  if (typeof s.status === "number") return (s.status & STATUS_BIT_LAMP_POWER_ON) !== 0;
  if (typeof s.actual_level === "number") return s.actual_level > 0;
  return undefined;
}

/** D4i raporunda arıza var mı: çevrimdışı, lamba arızası ya da sürücü arızası. */
export function d4iHasFault(d: D4iPeriodic): boolean {
  if (d.online === false) return true;
  const s = d.status;
  if (!s) return false;
  if (flagToBool(s.lamp_failure) === true) return true;
  if (typeof s.status === "number") {
    return (s.status & (STATUS_BIT_GEAR_FAILURE | STATUS_BIT_LAMP_FAILURE)) !== 0;
  }
  return false;
}

// ── Komut yanıtı (ESP32 → Backend, aynı /data topic'i) ───────
// Cihaz her komuttan sonra işleme sonucunu yayınlar. Korelasyon alanı yok —
// MAC topic'ten, hedef komut ise "o cihazın en son bekleyen komutu" olarak
// eşleştirilir (bkz. lib/mqtt.ts handleAck).
export const commandAckSchema = z.object({
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

/**
 * /data topic'inden gelen bir mesajı üç kontrattan birine ayrıştırır.
 * Ayrım sırası: `type` alanı → d4i, `deviceId` → eski tek/çok-lamba raporu,
 * yalnızca `status` → komut yanıtı.
 */
export type Uplink =
  | { kind: "d4i"; data: D4iPeriodic }
  | { kind: "legacy"; data: DataPayload }
  | { kind: "ack"; data: CommandAck };

export function parseUplink(raw: unknown): Uplink | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.type === "d4i_periodic") {
    const p = d4iPeriodicSchema.safeParse(obj);
    return p.success ? { kind: "d4i", data: p.data } : null;
  }
  if (typeof obj.deviceId === "string") {
    const p = dataPayloadSchema.safeParse(obj);
    return p.success ? { kind: "legacy", data: p.data } : null;
  }
  const p = commandAckSchema.safeParse(obj);
  return p.success ? { kind: "ack", data: p.data } : null;
}

// ── API request body (dashboard → backend) ───────────────────
// { action, value?, number? } — value "dim" için, number "efekt" için zorunlu.
export const commandRequestSchema = z
  .object({
    action: z.enum(ACTIONS),
    value: z.number().int().min(0).max(100).optional(),
    number: z.number().int().min(1).max(EFFECT_MAX_NUMBER).optional(),
    channel: z.number().int().min(0).max(MAX_CHANNEL).optional(), // tek lamba hedefi
    // Mors metni. Firmware yalnızca harf/rakam/boşluk kabul ettiği için
    // normalize edilir (Türkçe harfler ASCII'ye düşer, gerisi atılır).
    text: z
      .string()
      .transform(normalizeMorseText)
      .refine((t) => t.length <= MORSE_TEXT_MAX, {
        message: `Metin en fazla ${MORSE_TEXT_MAX} karakter olabilir`,
      })
      .optional(),
  })
  .refine((d) => d.action !== "dim" || typeof d.value === "number", {
    message: '"dim" aksiyonu için value (0-100) zorunludur',
    path: ["value"],
  })
  .refine((d) => d.action !== "efekt" || typeof d.number === "number", {
    message: `"efekt" aksiyonu için number (1-${EFFECT_MAX_NUMBER}) zorunludur`,
    path: ["number"],
  });
export type CommandRequest = z.infer<typeof commandRequestSchema>;

// ── Zone CRUD (dashboard → backend) ──────────────────────────
export const ZONE_STATUSES = ["ok", "warning", "fault"] as const;
export type ZoneStatusValue = (typeof ZONE_STATUSES)[number];

export const zoneCreateSchema = z.object({
  name: z.string().trim().min(1, "İsim zorunlu").max(100),
  slug: z.string().trim().max(100).optional(),
  district: z.string().trim().max(100).optional(),
  poleCount: z.number().int().min(0).max(100000).optional(),
  status: z.enum(ZONE_STATUSES).optional(),
});
export type ZoneCreate = z.infer<typeof zoneCreateSchema>;

export const zoneUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    district: z.string().trim().max(100).optional(),
    poleCount: z.number().int().min(0).max(100000).optional(),
    status: z.enum(ZONE_STATUSES).optional(),
    isOn: z.boolean().optional(),
    brightness: z.number().int().min(0).max(100).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: "En az bir alan güncellenmeli",
  });
export type ZoneUpdate = z.infer<typeof zoneUpdateSchema>;

// ── Device CRUD (dashboard → backend) ────────────────────────
// Cihaz kimliği = MAC. Girdi iki noktalı/noktasız olabilir; backend normalize eder.
export const deviceCreateSchema = z.object({
  mac: z.string().trim().min(1, "MAC adresi zorunlu"),
  zoneSlug: z.string().trim().min(1, "Bölge seçilmeli"),
  name: z.string().trim().max(100).optional(),
});
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;

// ── Fixture (lamba/kanal) CRUD (dashboard → backend) ─────────
export const fixtureCreateSchema = z.object({
  channel: z.number().int().min(0).max(MAX_CHANNEL),
  name: z.string().trim().max(100).optional(),
});
export type FixtureCreate = z.infer<typeof fixtureCreateSchema>;

/**
 * SSE üzerinden dashboard'a iletilen canlı olay. MQTT status mesajından veya
 * komut publish anından (optimistic) türetilir.
 */
export type LiveEvent = {
  zoneSlug?: string;
  deviceId?: string;
  channel?: number; // DALI kanal (lamba) no — cihaz/lamba seviyesi olay
  action?: Action;
  value?: number;
  isOn?: boolean;
  status: "ok" | "error";
  /**
   * Cihazın komut yanıtından gelen hata metni (örn. "bilinmeyen action").
   * Yalnızca ack olaylarında dolar; dashboard bunu bildirim + cihaz rozeti
   * olarak gösterir. `status:"ok"` gelen ack rozeti temizler.
   */
  error?: string;
  /** `describeDeviceError` kodu (örn. "channel-not-found") — UI dallanması için. */
  errorCode?: string;
  /** Olayın kaynağı: cihaz komut yanıtı mı, telemetri mi, komut echo'su mu. */
  kind?: "ack" | "telemetry" | "command";
  brightness?: number;
  activeFx?: number | null; // aktif efekt numarası (null = efekt yok)
  at: string;
  // Komut-echo event'lerinde (recordCommand) doldurulur; publish anındaki
  // sıraya göre monoton artar. Gerçek cihaz telemetrisinde (handleData) yok —
  // ardışık komutların arka plandaki DB yazımı farklı sürede bitip SSE'ye ters
  // sırayla düşebildiğinden (Kural #10), frontend bunu eski/yeni ayrımı için kullanır.
  seq?: number;
};
