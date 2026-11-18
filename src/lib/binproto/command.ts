import { encodeFrame } from "./codec";
import { COMMAND_ACTIONS } from "./fields";

/**
 * Sunucu → cihaz binary komutu (TYPE = COMMAND, 0x08). Saf; sunucu ve
 * test/mock betikleri kullanır. Doküman: MQTT-BINARY-PROTOKOL.html §Komutlar.
 *
 * Kablo kuralları JSON'la aynı (lib/mqtt.ts → buildJsonPayload):
 *  - `channel` yalnızca tek lamba hedeflenince yazılır; yokluğu = tüm lambalar
 *    (binary'de "broadcast"). Tüm hattı süren efektlerde çağıran zaten vermez.
 *  - `text` yalnızca doluysa yazılır: yoksa cihaz son Mors metnini çalar.
 *  - `id` = 1..65535 kısa komut kimliği; ack'te aynen döner. UUID kabloya çıkmaz,
 *    eşlemesi lib/mqtt.ts'te bellekte tutulur.
 *
 * `on`/`off` binary'de yoktur — çağıran önce `dim 100/0`'a çevirir (toWireCmd).
 */

export type BinaryCommandAction =
  | "dim"
  | "efekt"
  | "d4i_read"
  | "commission"
  | "ota_check"
  | ZoneCommandAction;

/**
 * Dinamik bölge aboneliği (firmware "Dinamik zone ve bölgesel OTA" planı).
 * YALNIZCA Meven:<MAC>/cmd'ye gider — cihaz başka topic'ten geleni -21 ile
 * reddeder. Komutlar idempotent; ya hep ya hiç uygulanır.
 */
export type ZoneCommandAction = "zone_add" | "zone_remove" | "zone_clear" | "zone_list";
export const ZONE_COMMAND_ACTIONS: readonly ZoneCommandAction[] = [
  "zone_add",
  "zone_remove",
  "zone_clear",
  "zone_list",
];

/** Bir pakette en fazla slug (cihazın 256 baytlık komut kuyruğu elemanı). */
export const ZONES_PER_COMMAND = 3;
/** Cihaz başına toplam bölge (firmware sabiti). */
export const ZONES_PER_DEVICE = 16;
/** Cihazın kabul ettiği slug: a-z, 0-9, '-', 1-32 karakter; `all` ayrılmış. */
export const DEVICE_ZONE_SLUG_MAX = 32;
const DEVICE_ZONE_SLUG_RE = /^[a-z0-9-]{1,32}$/;

export function isDeviceZoneSlug(slug: string): boolean {
  return DEVICE_ZONE_SLUG_RE.test(slug) && slug !== "all";
}

export type BinaryCommand = {
  action: BinaryCommandAction;
  /** 1..65535; 0 ya da yok = id yok. */
  id?: number;
  channel?: number;
  value?: number;
  number?: number;
  text?: string;
  /** Yalnızca zone_add / zone_remove: 1..3 slug (her biri ayrı 0xA9 alanı). */
  zones?: readonly string[];
};

const ACTION_CODES: ReadonlyMap<string, number> = new Map(
  Object.entries(COMMAND_ACTIONS).map(([code, name]) => [name, Number(code)]),
);

export function isBinaryCommandAction(a: string): a is BinaryCommandAction {
  return ACTION_CODES.has(a);
}

export function encodeCommand(cmd: BinaryCommand): Uint8Array {
  const action = ACTION_CODES.get(cmd.action);
  if (action === undefined) throw new Error(`binary komutta olmayan action: ${cmd.action}`);
  if (cmd.id !== undefined && (!Number.isInteger(cmd.id) || cmd.id < 1 || cmd.id > 0xffff)) {
    throw new Error(`komut id'si 1..65535 olmalı: ${cmd.id}`);
  }
  const zones = cmd.zones ?? [];
  if (cmd.action === "zone_add" || cmd.action === "zone_remove") {
    if (zones.length < 1 || zones.length > ZONES_PER_COMMAND) {
      throw new Error(`${cmd.action} 1..${ZONES_PER_COMMAND} bölge ister: ${zones.length}`);
    }
  } else if (zones.length > 0) {
    throw new Error(`${cmd.action} bölge almaz`);
  }
  for (const z of zones) {
    if (!isDeviceZoneSlug(z)) throw new Error(`cihazın kabul etmeyeceği bölge slug'ı: "${z}"`);
  }
  return encodeFrame("COMMAND", [
    ["COMMAND_ACTION", action],
    ["COMMAND_ID", cmd.id],
    ["COMMAND_CHANNEL", cmd.channel],
    ["COMMAND_VALUE", cmd.value],
    ["COMMAND_EFFECT_NUMBER", cmd.number],
    ["COMMAND_EFFECT_TEXT", cmd.text ? cmd.text : undefined],
    ...zones.map((z) => ["COMMAND_ZONE", z] as const),
  ]);
}
