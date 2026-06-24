import { z } from "zod";

/**
 * MQTT payload kontratı — CLAUDE.md "Payload Formatları" bölümünün tek
 * kaynağı. LoRa geçişinde transport binary olur ama bu semantik korunur.
 */

export const ACTIONS = ["on", "off", "dim"] as const;
export type Action = (typeof ACTIONS)[number];

// ── Command (Backend → ESP32) ────────────────────────────────
// Yayınlanan komut payload'ı yalın: { action, value? }. ESP yalnız bunları okur.
export const commandPayloadSchema = z.object({
  action: z.enum(ACTIONS),
  value: z.number().int().min(0).max(100).optional(),
});
export type CommandPayload = z.infer<typeof commandPayloadSchema>;

// ── Data (ESP32 → Backend, Meven:<MAC>/data) ─────────────────
export const dataPayloadSchema = z.object({
  deviceId: z.string(), // MAC (iki noktasız)
  brightness: z.number().int().min(0).max(100).optional(),
  relayStatus: z.enum(["on", "off"]).optional(),
  temperature: z.number().optional(),
  rssi: z.number().int().optional(),
  status: z.enum(["ok", "error"]),
});
export type DataPayload = z.infer<typeof dataPayloadSchema>;

// ── API request body (dashboard → backend) ───────────────────
// { action, value? } — value yalnızca "dim" için zorunlu.
export const commandRequestSchema = z
  .object({
    action: z.enum(ACTIONS),
    value: z.number().int().min(0).max(100).optional(),
  })
  .refine((d) => d.action !== "dim" || typeof d.value === "number", {
    message: '"dim" aksiyonu için value (0-100) zorunludur',
    path: ["value"],
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

/**
 * SSE üzerinden dashboard'a iletilen canlı olay. MQTT status mesajından veya
 * komut publish anından (optimistic) türetilir.
 */
export type LiveEvent = {
  zoneSlug?: string;
  deviceId?: string;
  action?: Action;
  value?: number;
  isOn?: boolean;
  status: "ok" | "error";
  brightness?: number;
  at: string;
};
