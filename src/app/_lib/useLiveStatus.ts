"use client";

import { useEffect } from "react";
import type { LiveEvent } from "@/types/lighting";
import { usePanel, withCustomer } from "./panel";

const SSE_URL = process.env.NEXT_PUBLIC_SSE_URL ?? "/api/events";

/**
 * TEK EventSource, tüm dinleyiciler ortak. Her bileşen kendi bağlantısını
 * açsaydı (dashboard + cihaz listesi + cihaz modali + hata bildirimleri)
 * tarayıcının origin başına eşzamanlı bağlantı sınırına (HTTP/1.1'de 6)
 * yaklaşır, normal fetch'ler sıraya girerdi.
 *
 * Akış müşteriye kapsamlıdır (`/api/events?customer=<slug>`); sunucu yalnızca
 * o müşterinin olaylarını iletir. Admin başka bir müşterinin paneline
 * geçtiğinde URL değişir ve bağlantı yeniden açılır.
 */
let source: EventSource | null = null;
let sourceUrl: string | null = null;
const listeners = new Set<(e: LiveEvent) => void>();

function openSource(url: string) {
  if (source && sourceUrl === url) return;
  source?.close();
  const es = new EventSource(url);

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
    // EventSource otomatik yeniden bağlanır; sadece logla. Oturum düştüyse
    // (401) tarayıcı yeniden denemeyi bırakır — sayfa zaten /login'e düşer.
    console.warn("[sse] bağlantı hatası, yeniden bağlanılıyor…");
  };

  source = es;
  sourceUrl = url;
}

/**
 * Panelin müşterisine ait SSE akışını dinler ve her LiveEvent için callback'i
 * çağırır. Son dinleyici de gidince bağlantı kapanır.
 */
export function useLiveStatus(onEvent: (e: LiveEvent) => void) {
  const { customerSlug } = usePanel();
  const url = withCustomer(SSE_URL, customerSlug);

  useEffect(() => {
    listeners.add(onEvent);
    openSource(url);

    return () => {
      listeners.delete(onEvent);
      if (listeners.size === 0) {
        source?.close();
        source = null;
        sourceUrl = null;
      }
    };
  }, [onEvent, url]);
}
