import { EventEmitter } from "node:events";
import { ownerOf, peekTenancy } from "@/lib/tenancy";

/**
 * Alan olayları (domain events) — "ne oldu" bilgisini yayınlayan tek bus.
 * `events.ts` (LiveEvent) ekran durumunu taşır; bu bus ise iş olaylarını:
 * şu an arıza epizodunun açılması/kapanması.
 *
 * Yayın noktası TEKTİR: `lib/faultLog.ts → syncFaultEvents`, satırı DB'ye
 * yazdıktan sonra. Aboneler:
 *  - SSE (`/api/events`) → istemciye isimli `event: fault` olarak iletir.
 *  - (Push fazı) FCM gönderici — arıza koduna dokunmadan buraya abone olur.
 *
 * Tek instance (Kural #8); yatay ölçeklemede Redis pub/sub ile değişir.
 */

export type FaultDomainEvent = {
  type: "fault.opened" | "fault.resolved";
  /** fault_events.id */
  id: number;
  /** SUNUCU İÇİ: sahip müşteri. SSE süzmek için kullanır, istemciye gitmez. */
  customerId: string;
  deviceId: string; // MAC
  /** DALI kanalı (lamba); null = cihaz seviyesi (komut hatası). */
  channel: number | null;
  code: string;
  detail: string | null;
  startedAt: string;
  resolvedAt: string | null;
};

export type DomainEvent = FaultDomainEvent;

const g = globalThis as unknown as { __fenerDomainBus?: EventEmitter };
const bus =
  g.__fenerDomainBus ??
  (() => {
    const e = new EventEmitter();
    e.setMaxListeners(0);
    return e;
  })();
g.__fenerDomainBus = bus;

const CHANNEL = "domain";

/**
 * Arıza olayı yayınlar. Sahibi çözülemeyen MAC (kayıtsız cihaz) hiçbir
 * müşteriye ait olmadığı için yayınlanmaz.
 */
export function emitFaultEvent(event: Omit<FaultDomainEvent, "customerId">): void {
  const idx = peekTenancy();
  const customerId = idx ? ownerOf(idx, { deviceId: event.deviceId }) : undefined;
  if (!customerId) return;
  bus.emit(CHANNEL, { ...event, customerId } satisfies FaultDomainEvent);
}

/**
 * Abone olur. Dinleyici hatası yayıncıya (MQTT işleyicisi) SIZMAZ: EventEmitter
 * senkron çağırdığı için her dinleyici ayrı try/catch ile sarılır.
 */
export function onDomainEvent(listener: (event: DomainEvent) => void): () => void {
  const safe = (event: DomainEvent) => {
    try {
      listener(event);
    } catch (err) {
      console.error("[domain] dinleyici hatası:", err);
    }
  };
  bus.on(CHANNEL, safe);
  return () => bus.off(CHANNEL, safe);
}
