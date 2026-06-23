"use client";

import { useEffect } from "react";
import type { LiveEvent } from "@/types/lighting";

const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL ?? "/api/events";

/**
 * /api/events SSE akışını dinler ve her LiveEvent için callback'i çağırır.
 * Bağlantı kopunca EventSource kendiliğinden yeniden bağlanır.
 */
export function useLiveStatus(onEvent: (e: LiveEvent) => void) {
  useEffect(() => {
    const source = new EventSource(SSE_URL);

    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as LiveEvent);
      } catch {
        /* heartbeat / yorum satırları yoksayılır */
      }
    };

    source.onerror = () => {
      // EventSource otomatik yeniden bağlanır; sadece logla.
      console.warn("[sse] bağlantı hatası, yeniden bağlanılıyor…");
    };

    return () => source.close();
  }, [onEvent]);
}
