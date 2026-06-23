import { z } from "zod";

/**
 * MQTT payload kontratı — CLAUDE.md "Payload Formatları" bölümünün tek
 * kaynağı. LoRa geçişinde transport binary olur ama bu semantik korunur.
 */

export const ACTIONS = ["on", "off", "dim"] as const;
export type Action = (typeof ACTIONS)[number];

// ── Command (Backend → ESP32) ────────────────────────────────
export const commandPayloadSchema = z.object({
  action: z.enum(ACTIONS),
  value: z.number().int().min(0).max(100).optional(),
  zoneId: z.string().optional(),
  deviceId: z.string().optional(),
  requestId: z.string(),
  timestamp: z.string(),
});
export type CommandPayload = z.infer<typeof commandPayloadSchema>;

// ── Status (ESP32 → Backend) ─────────────────────────────────
export const statusPayloadSchema = z.object({
  deviceId: z.string(),
  zoneId: z.string().optional(),
  action: z.enum(ACTIONS).optional(),
  value: z.number().int().min(0).max(100).optional(),
  status: z.enum(["ok", "error"]),
  rssi: z.number().int().optional(),
  timestamp: z.string().optional(),
});
export type StatusPayload = z.infer<typeof statusPayloadSchema>;

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
