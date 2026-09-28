"use client";

import { useEffect, useState } from "react";

/**
 * Belirli aralıklarla tazelenen "şimdi" (ms). Render sırasında `Date.now()`
 * çağırmak saf değil (react-hooks/purity) ve SSR ile hidrasyon uyuşmazlığı
 * doğurur; bu yüzden ilk değer mount'tan sonra gelir — o ana kadar `null`.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // İlk değeri de bir callback'ten ver: efekt gövdesinde senkron setState
    // cascading render'a yol açar.
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}
