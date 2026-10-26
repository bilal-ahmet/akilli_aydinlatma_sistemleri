"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type RowMenuItem = { label: string; onSelect: () => void; danger?: boolean };

const GAP = 4;
const EDGE = 8;
/** Öğe yüksekliği (py-2 + text-sm) ve kap dolgusu; yalnızca yukarı/aşağı kararı için. */
const ITEM_H = 36;
const PAD_H = 10;

type Placement = { left: number; top?: number; bottom?: number };

/**
 * Satır sonundaki "···" menüsü. Menü `body`'ye portal ile çizilir ve
 * `position: fixed` konumlanır: tabloların `overflow` kabı ve kartların
 * `overflow-hidden` kenarı menüyü kesmez, kaydırma çubuğu açmaz. Altta yer
 * yoksa yukarı açılır; sayfa kayınca ya da pencere boyutu değişince kapanır.
 */
export function RowMenu({ label, items, width = 176 }: { label: string; items: RowMenuItem[]; width?: number }) {
  const [place, setPlace] = useState<Placement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = place !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggle() {
    if (open) return setPlace(null);
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const height = items.length * ITEM_H + PAD_H;
    const left = Math.max(EDGE, Math.min(b.right - width, window.innerWidth - width - EDGE));
    const fitsBelow = b.bottom + GAP + height <= window.innerHeight - EDGE;
    setPlace(fitsBelow ? { left, top: b.bottom + GAP } : { left, bottom: window.innerHeight - b.top + GAP });
  }

  const item = "block w-full px-3.5 py-2 text-left text-sm transition-colors";
  return (
    // Portal olayları React ağacında yukarı kabarır: satırın kendi tıklaması tetiklenmesin.
    <div onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-muted transition-colors hover:bg-panel-2 hover:text-text"
      >
        ···
      </button>
      {place
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              style={{ position: "fixed", width, ...place }}
              className="z-50 overflow-hidden rounded-xl border border-border bg-panel py-1 shadow-xl"
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  className={`${item} ${it.danger ? "text-danger hover:bg-danger-soft" : "text-text hover:bg-panel-2"}`}
                  onClick={() => {
                    setPlace(null);
                    it.onSelect();
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
