"use client";

import { useEffect } from "react";

/** İçerik genişliği: form/onay diyalogları `md`, cihaz paneli `lg`. */
type ModalSize = "md" | "lg";

const SIZE: Record<ModalSize, string> = {
  md: "max-w-[460px]",
  lg: "max-w-2xl",
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Başlığın altında gösterilen ikincil satır (MAC, bölge vb.) */
  subtitle?: React.ReactNode;
  size?: ModalSize;
  /**
   * Alt eylem çubuğu (İptal / Kaydet). Gövdeyle birlikte kaymaz, üstünde
   * ayırıcı çizgi olur. Form gönderimi için düğmede `form="<id>"` kullanın.
   */
  footer?: React.ReactNode;
  /**
   * Verilirse gövde + alt çubuk tek `<form>` olur: alt çubuktaki
   * `type="submit"` düğmesi ve Enter tuşu formu gönderir.
   */
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}

/**
 * Diyalog kabuğu: başlık ve alt çubuk sabit kalır, gövde kendi içinde
 * kaydırılır. Bu yüzden uzun içerikler (cihaz paneli) küçük ekranlarda da
 * taşmadan sığar — içeride ayrıca `overflow-y-auto` kutusu açmayın, iç içe
 * kaydırma okunabilirliği bozar.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = "md",
  footer,
  onSubmit,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const body = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-[18px] sm:px-[26px]">
        {children}
      </div>
      {footer ? (
        <div className="flex shrink-0 flex-wrap justify-end gap-2.5 border-t border-border px-5 pb-[22px] pt-4 sm:px-[26px]">
          {footer}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-[var(--scrim)]"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`relative z-10 flex max-h-[92dvh] w-full ${SIZE[size]} flex-col overflow-hidden rounded-[18px] border border-border bg-panel shadow-[0_24px_60px_rgba(0,0,0,.25)]`}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-1.5 pt-6 sm:px-[26px]">
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-text">{title}</h2>
            {subtitle ? <div className="mt-1 text-[13.5px] text-muted">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="-mr-1.5 -mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-panel-2 hover:text-text"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
