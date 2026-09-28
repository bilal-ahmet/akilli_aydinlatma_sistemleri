"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ROLE_LABELS } from "@/lib/auth/roles";
import type { Viewer } from "@/types/admin";

export type MenuLink = { href: string; label: string };

/**
 * Kullanıcı menüsü: kim olduğu, hızlı bağlantılar ve çıkış. Üst çubukta
 * (varsayılan) sağa yaslı aşağı açılır; kenar çubuğunda `placement="up"` ile
 * tam genişlik düğme olarak yukarı açılır.
 */
export function UserMenu({
  user,
  links,
  placement = "down",
}: {
  user: Viewer;
  links: MenuLink[];
  placement?: "down" | "up";
}) {
  const up = placement === "up";
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logout() {
    setLeaving(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  const initials = (user.displayName || user.username).slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-xl text-left transition-colors ${
          up
            ? "w-full px-2 py-1.5 hover:bg-panel-2"
            : "border border-border bg-panel-2 py-1 pl-1 pr-2.5 hover:border-glow/40"
        }`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-glow/20 text-xs font-bold text-text">
          {initials}
        </span>
        {up ? (
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold text-text">
              {user.displayName || user.username}
            </span>
            <span className="truncate text-[11.5px] text-muted">{ROLE_LABELS[user.role]}</span>
          </span>
        ) : (
          <span className="hidden max-w-[10rem] truncate text-sm font-medium text-text sm:block">
            {user.displayName || user.username}
          </span>
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden className={`shrink-0 text-muted ${up ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className={`absolute z-30 w-60 overflow-hidden rounded-xl border border-border bg-panel shadow-xl ${
            up ? "bottom-full left-0 mb-2" : "right-0 mt-2"
          }`}
        >
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-semibold text-text">{user.displayName || user.username}</p>
            <p className="truncate font-mono text-xs text-muted">{user.username}</p>
            <p className="mt-1 text-[11px] text-accent">{ROLE_LABELS[user.role]}</p>
          </div>
          <div className="py-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="block px-4 py-2 text-sm text-text transition-colors hover:bg-glow/10"
              >
                {l.label}
              </Link>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              disabled={leaving}
              className="block w-full px-4 py-2 text-left text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              {leaving ? "Çıkış yapılıyor…" : "Çıkış yap"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
