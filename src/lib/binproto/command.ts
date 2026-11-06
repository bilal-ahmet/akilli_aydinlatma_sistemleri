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

export type BinaryCommandAction = "dim" | "efekt" | "d4i_read" | "commission" | "ota_check";

export type BinaryCommand = {
  action: BinaryCommandAction;
  /** 1..65535; 0 ya da yok = id yok. */
  id?: number;
  channel?: number;
  value?: number;
  number?: number;
  text?: string;
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
  return encodeFrame("COMMAND", [
    ["COMMAND_ACTION", action],
    ["COMMAND_ID", cmd.id],
    ["COMMAND_CHANNEL", cmd.channel],
    ["COMMAND_VALUE", cmd.value],
    ["COMMAND_EFFECT_NUMBER", cmd.number],
    ["COMMAND_EFFECT_TEXT", cmd.text ? cmd.text : undefined],
  ]);
}
