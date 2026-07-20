import { z } from "zod";
import { EFFECT_COUNT } from "@/lib/effects";

/**
 * MQTT payload kontratı — CLAUDE.md "Payload Formatları" bölümünün tek
 * kaynağı. LoRa geçişinde transport binary olur ama bu semantik korunur.
 */

export const ACTIONS = ["on", "off", "dim", "efekt"] as const;
export type Action = (typeof ACTIONS)[number];

// Kanal (DALI lambası) no: bir ESP'ye bağlı bağımsız aydınlatma adresi.
// 0-63 (DALI kısa adres). Komutta yoksa "tüm cihaz" (bütün lambalar) hedeflenir.
export const MAX_CHANNEL = 63;

// ── Command (Backend → ESP32) ────────────────────────────────
// Yayınlanan komut payload'ı yalın: { action, value? } veya { action:"efekt", number }.
// Opsiyonel `channel` tek bir DALI kanalını (lambayı) hedefler; yoksa tüm cihaz.
export const commandPayloadSchema = z.object({
  action: z.enum(ACTIONS),
  value: z.number().int().min(0).max(100).optional(),
  number: z.number().int().min(1).max(EFFECT_COUNT).optional(), // efekt sıra no
  channel: z.number().int().min(0).max(MAX_CHANNEL).optional(), // DALI kanal (lamba) no
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

// ── API request body (dashboard → backend) ───────────────────
// { action, value?, number? } — value "dim" için, number "efekt" için zorunlu.
export const commandRequestSchema = z
  .object({
    action: z.enum(ACTIONS),
    value: z.number().int().min(0).max(100).optional(),
    number: z.number().int().min(1).max(EFFECT_COUNT).optional(),
    channel: z.number().int().min(0).max(MAX_CHANNEL).optional(), // tek lamba hedefi
  })
  .refine((d) => d.action !== "dim" || typeof d.value === "number", {
    message: '"dim" aksiyonu için value (0-100) zorunludur',
    path: ["value"],
  })
  .refine((d) => d.action !== "efekt" || typeof d.number === "number", {
    message: '"efekt" aksiyonu için number (1-14) zorunludur',
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
  brightness?: number;
  activeFx?: number | null; // aktif efekt numarası (null = efekt yok)
  at: string;
  // Komut-echo event'lerinde (recordCommand) doldurulur; publish anındaki
  // sıraya göre monoton artar. Gerçek cihaz telemetrisinde (handleData) yok —
  // ardışık komutların arka plandaki DB yazımı farklı sürede bitip SSE'ye ters
  // sırayla düşebildiğinden (Kural #10), frontend bunu eski/yeni ayrımı için kullanır.
  seq?: number;
};
