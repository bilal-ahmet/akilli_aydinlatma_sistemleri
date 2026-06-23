import { EventEmitter } from "node:events";
import type { LiveEvent } from "@/types/lighting";

/**
 * MQTT handler → SSE route köprüsü. Tek Node process içinde in-memory event
 * bus. globalThis ile cache'lenir (HMR'da yeniden oluşmasın). Yatay
 * ölçeklemede burası Redis pub/sub ile değişir (CLAUDE.md kapsam dışı notu).
 */
const globalForBus = globalThis as unknown as {
  __fenerBus?: EventEmitter;
};

const bus =
  globalForBus.__fenerBus ??
  (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0); // SSE client sayısı sınırsız
    return e;
  })();

globalForBus.__fenerBus = bus;

const CHANNEL = "live";

export function emitLiveEvent(event: LiveEvent): void {
  bus.emit(CHANNEL, event);
}

export function onLiveEvent(listener: (event: LiveEvent) => void): () => void {
  bus.on(CHANNEL, listener);
  return () => bus.off(CHANNEL, listener);
}
