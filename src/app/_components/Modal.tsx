"use client";

import { useEffect } from "react";

/** İçerik genişliği: varsayılan form/onay diyalogları `md`, cihaz paneli `lg`. */
type ModalSize = "md" | "lg";

const SIZE: Record<ModalSize, string> = {
  md: "max-w-md",
  lg: "max-w-2xl",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Başlığın altında gösterilen ikincil satır (MAC, bölge vb.) */
  subtitle?: React.ReactNode;
  size?: ModalSize;
  children: React.ReactNode;
}

/**
 * Diyalog kabuğu: başlık sabit kalır, gövde kendi içinde kaydırılır. Bu yüzden
 * uzun içerikler (cihaz paneli) küçük ekranlarda da taşmadan sığar — içeride
 * ayrıca `overflow-y-auto` kutusu açmayın, iç içe kaydırma okunabilirliği bozar.
 */
export function Modal({ open, onClose, title, subtitle, size = "md", children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`relative z-10 flex max-h-[92dvh] w-full ${SIZE[size]} flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-xl`}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold text-text sm:text-xl">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-sm text-muted">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="-mr-1.5 -mt-0.5 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-panel-2 hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6 sm:py-5">
          {children}
        </div>
      </div>
    </div>
  );
}
