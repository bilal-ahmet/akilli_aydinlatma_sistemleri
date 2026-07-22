"use client";

import { useCallback, useRef, useState } from "react";
import type { LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { formatMac } from "@/lib/mac";

/** Bildirim ekranda bu kadar kalır. */
const TOAST_TTL_MS = 8000;
/** Aynı anda gösterilen en fazla bildirim (eskiler düşer). */
const MAX_TOASTS = 4;

type Toast = { id: number; deviceId?: string; message: string };

/**
 * Cihazın komut yanıtından (`{"status":"error","error":"..."}`) gelen hataları
 * sağ altta bildirim olarak gösterir. Olaylar SSE'den akar (LiveEvent.error);
 * kaynak MQTT handler'ındaki handleAck'tir. Kalıcı gösterim cihaz listesindeki
 * rozette — burası yalnızca "az önce oldu" sinyali.
 */
export function ErrorToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const onLive = useCallback(
    (e: LiveEvent) => {
      if (!e.error) return;
      const id = nextId.current++;
      setToasts((ts) => [...ts, { id, deviceId: e.deviceId, message: e.error! }].slice(-MAX_TOASTS));
      setTimeout(() => dismiss(id), TOAST_TTL_MS);
    },
    [dismiss],
  );
  useLiveStatus(onLive);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-danger/40 bg-panel p-3 shadow-lg"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="mt-0.5 shrink-0 text-danger"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5M12 16h.01" />
          </svg>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-danger">Cihaz komutu reddetti</p>
            <p className="mt-0.5 text-sm break-words text-text">{t.message}</p>
            {t.deviceId ? (
              <p className="mt-0.5 font-mono text-[11px] text-muted">{formatMac(t.deviceId)}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Bildirimi kapat"
            className="shrink-0 rounded-md p-1 text-muted transition-colors hover:text-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
