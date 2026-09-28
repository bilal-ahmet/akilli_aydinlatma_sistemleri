"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu, type MenuLink } from "./UserMenu";
import type { Viewer } from "@/types/admin";

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // İlk değeri de bir callback'ten ver: efekt gövdesinde senkron
    // setState cascading render'a yol açar.
    const tick = () => setNow(new Date());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);
  return now;
}

export function TopBar({
  subtitle = "Sokak Aydınlatma Kontrolü",
  homeHref = "/",
  user,
  links = [],
}: {
  /** Logo altındaki satır — müşteri panelinde müşteri adı. */
  subtitle?: string;
  homeHref?: string;
  user?: Viewer | null;
  links?: MenuLink[];
} = {}) {
  const now = useClock();
  const time = now
    ? now.toLocaleTimeString("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "--:--:--";
  const date = now
    ? now.toLocaleDateString("tr-TR", {
        day: "numeric",
        month: "long",
        weekday: "long",
      })
    : "";

  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href={homeHref} className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="grid h-9 w-9 place-items-center rounded-xl bg-glow/15 text-lg shadow-[0_0_18px_-4px_var(--glow)]"
          >
            💡
          </span>
          <div className="leading-tight">
            <p className="font-display text-base font-bold tracking-tight text-text">
              Fener
            </p>
            <p className="truncate text-[11px] text-muted">{subtitle}</p>
          </div>
        </Link>

        <div className="flex items-center gap-3 sm:gap-5">
          <div className="hidden text-right sm:block">
            <p className="font-mono text-sm tabular-nums text-text">{time}</p>
            <p className="text-[11px] capitalize text-muted">{date}</p>
          </div>
          <ThemeToggle />
          {user ? <UserMenu user={user} links={links} /> : null}
        </div>
      </div>
    </header>
  );
}
