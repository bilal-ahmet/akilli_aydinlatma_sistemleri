"use client";

import { useCallback, useRef, useState } from "react";
import type { LiveEvent } from "@/types/lighting";
import { useLiveStatus } from "@/app/_lib/useLiveStatus";
import { describeDeviceError, type DeviceErrorInfo } from "@/lib/deviceErrors";
import { formatMac } from "@/lib/mac";

/** Bildirim ekranda bu kadar kalır. */
const TOAST_TTL_MS = 8000;
/** Aynı anda gösterilen en fazla bildirim (eskiler düşer). */
const MAX_TOASTS = 4;

type Toast = {
  id: number;
  deviceId?: string;
  channel?: number;
  info: DeviceErrorInfo;
};

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
      const toast: Toast = {
        id,
        deviceId: e.deviceId,
        channel: e.channel,
        info: describeDeviceError(e.error),
      };
      setToasts((ts) => [...ts, toast].slice(-MAX_TOASTS));
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
            <p className="text-xs font-semibold text-danger">{t.info.title}</p>
            <p className="mt-0.5 text-sm break-words text-text">{t.info.cause}</p>
            {t.info.hint ? (
              <p className="mt-1 text-[11px] break-words text-muted">{t.info.hint}</p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-muted">
              {t.deviceId ? <span>{formatMac(t.deviceId)}</span> : null}
              {typeof t.channel === "number" ? <span>· ch{t.channel}</span> : null}
              {/* Katalogda olmayan hatada ham metin zaten sebep satırında. */}
              {t.info.known ? <span className="opacity-70">· {t.info.raw}</span> : null}
            </p>
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
