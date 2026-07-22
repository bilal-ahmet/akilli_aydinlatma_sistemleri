"use client";

import { useEffect } from "react";
import type { LiveEvent } from "@/types/lighting";

const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL ?? "/api/events";

/**
 * TEK EventSource, tüm dinleyiciler ortak. Her bileşen kendi bağlantısını
 * açsaydı (dashboard + cihaz listesi + cihaz modali + hata bildirimleri)
 * tarayıcının origin başına eşzamanlı bağlantı sınırına (HTTP/1.1'de 6)
 * yaklaşır, normal fetch'ler sıraya girerdi.
 */
let source: EventSource | null = null;
const listeners = new Set<(e: LiveEvent) => void>();

function openSource() {
  if (source) return;
  const es = new EventSource(SSE_URL);

  es.onmessage = (msg) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(msg.data) as LiveEvent;
    } catch {
      return; // heartbeat / yorum satırları yoksayılır
    }
    // Kopya üzerinde gez: dinleyici callback'i içinde abonelik değişebilir.
    for (const listener of [...listeners]) listener(event);
  };

  es.onerror = () => {
    // EventSource otomatik yeniden bağlanır; sadece logla.
    console.warn("[sse] bağlantı hatası, yeniden bağlanılıyor…");
  };

  source = es;
}

/**
 * /api/events SSE akışını dinler ve her LiveEvent için callback'i çağırır.
 * Son dinleyici de gidince bağlantı kapanır.
 */
export function useLiveStatus(onEvent: (e: LiveEvent) => void) {
  useEffect(() => {
    listeners.add(onEvent);
    openSource();

    return () => {
      listeners.delete(onEvent);
      if (listeners.size === 0) {
        source?.close();
        source = null;
      }
    };
  }, [onEvent]);
}
