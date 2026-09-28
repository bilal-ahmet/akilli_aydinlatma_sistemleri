import { EventEmitter } from "node:events";
import type { LiveEvent } from "@/types/lighting";
import { ownerOf, peekTenancy } from "@/lib/tenancy";

/**
 * MQTT handler → SSE route köprüsü. Tek Node process içinde in-memory event
 * bus. globalThis ile cache'lenir (HMR'da yeniden oluşmasın). Yatay
 * ölçeklemede burası Redis pub/sub ile değişir (CLAUDE.md kapsam dışı notu).
 *
 * Çok kiracılık: her olay `customerId` ile etiketlenir; SSE route'u yalnızca
 * izleyicinin müşterisine ait olayları iletir. Sahibi çözülemeyen olaylar
 * (kayıtsız MAC) hiçbir müşteri paneline gitmez.
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
  if (!event.customerId) {
    const idx = peekTenancy();
    const owner = idx ? ownerOf(idx, event) : undefined;
    if (owner) event = { ...event, customerId: owner };
  }
  bus.emit(CHANNEL, event);
}

export function onLiveEvent(listener: (event: LiveEvent) => void): () => void {
  bus.on(CHANNEL, listener);
  return () => bus.off(CHANNEL, listener);
}
