"use client";

import { useEffect } from "react";

/** Varsayılan mutabakat aralığı — cihaz raporu periyoduyla (~30 sn) uyumlu. */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * SSE "kaçan olay" sigortası.
 *
 * Canlı güncelleme `/api/events` üzerinden gelir ama akış kopabilir (proxy
 * zaman aşımı, uyuyan sekme, ağ değişimi) ve EventSource yeniden bağlandığında
 * kaçırdığı olayları TEKRAR OYNATMAZ — ekran sessizce bayat kalır. Bu hook
 * belirli aralıklarla ve sekme öne geldiğinde gerçeği DB'den yeniden okutur.
 *
 * `refresh` referansı sabit olmalı (useCallback), yoksa her render'da yeni
 * zamanlayıcı kurulur.
 */
export function useReconcile(refresh: () => void, intervalMs = DEFAULT_INTERVAL_MS) {
  useEffect(() => {
    const timer = setInterval(refresh, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, intervalMs]);
}
