"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ThemeMode } from "@/app/_lib/types";
import type { Viewer } from "@/types/admin";
import { useLighting } from "@/app/_lib/lighting";
import { usePanel } from "@/app/_lib/panel";
import { openAlerts } from "@/app/_lib/alerts";
import { BrandMark } from "./BrandMark";
import { useTheme } from "./ThemeProvider";
import { UserMenu, type MenuLink } from "./UserMenu";
import { ErrorToasts } from "./ErrorToasts";

interface NavItem {
  href: string;
  label: string;
  badge?: number;
  /** Rozet dikkat rengiyle (açık arıza) gösterilsin mi? */
  alert?: boolean;
  /** Yalnızca tam eşleşmede aktif (Genel Bakış = panel kökü). */
  exact?: boolean;
}

const THEMES: { mode: ThemeMode; label: string }[] = [
  { mode: "light", label: "Açık" },
  { mode: "dark", label: "Koyu" },
  { mode: "auto", label: "Otomatik" },
];

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  return (
    <div className="flex flex-col gap-2 px-1">
      <p className="eyebrow px-1 !text-[11px]">Tema</p>
      <div
        role="radiogroup"
        aria-label="Tema"
        className="grid grid-cols-3 gap-0.5 rounded-[9px] bg-panel-2 p-[3px]"
      >
        {THEMES.map((t) => {
          const active = mode === t.mode;
          return (
            <button
              key={t.mode}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setMode(t.mode)}
              className={`h-7 rounded-[7px] text-xs transition-colors ${
                active
                  ? "bg-panel font-semibold text-text shadow-[0_1px_2px_rgba(0,0,0,.08)]"
                  : "text-ink-2 hover:text-text"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="px-1 text-[11.5px] leading-snug text-muted">
        Otomatik: 07:00–20:00 arası açık tema.
      </p>
    </div>
  );
}

function SidebarContent({
  user,
  links,
  onNavigate,
}: {
  user: Viewer;
  links: MenuLink[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { customerSlug, customerName, role, isAdminView } = usePanel();
  const { zones, devices, faults } = useLighting();
  const alertCount = openAlerts(faults, devices).length;

  const base = `/c/${customerSlug}`;
  const nav: NavItem[] = [
    { href: base, label: "Genel Bakış", exact: true },
    { href: `${base}/bolgeler`, label: "Bölgeler", badge: zones.length },
    { href: `${base}/cihazlar`, label: "Cihazlar", badge: devices.length },
    { href: `${base}/arizalar`, label: "Arızalar", badge: alertCount, alert: alertCount > 0 },
    { href: `${base}/efektler`, label: "Efektler" },
  ];
  if (role === "admin" || role === "manager") {
    nav.push({ href: `${base}/kullanicilar`, label: "Kullanıcılar" });
  }

  return (
    <div className="flex h-full flex-col gap-6 px-3.5 py-5">
      <Link href={base} onClick={onNavigate} className="flex items-center gap-2.5 px-2">
        <BrandMark />
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-base font-bold tracking-tight text-text">Fener</span>
          <span className="truncate text-[11.5px] text-muted">{customerName}</span>
        </span>
      </Link>

      <nav aria-label="Panel" className="flex flex-col gap-0.5">
        {nav.map((n) => {
          const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex h-[38px] items-center gap-2.5 rounded-[9px] px-2.5 text-sm transition-colors ${
                active
                  ? "bg-[linear-gradient(90deg,oklch(0.77_0.16_68/.22),oklch(0.77_0.16_68/.04))] font-semibold text-text"
                  : "font-medium text-ink-2 hover:bg-panel-2 hover:text-text"
              }`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-[2px] ${
                  active ? "bg-glow shadow-[0_0_10px_var(--acc)]" : "bg-border-strong"
                }`}
              />
              <span className="flex-1">{n.label}</span>
              {n.badge !== undefined ? (
                <span
                  className={`font-mono text-[11px] ${
                    n.alert ? "rounded-md bg-danger-soft px-1.5 font-semibold text-danger" : "text-muted"
                  }`}
                >
                  {n.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {isAdminView ? (
        <Link
          href="/admin"
          onClick={onNavigate}
          className="mx-1 rounded-[10px] border border-border px-3 py-2 text-[12.5px] text-ink-2 transition-colors hover:border-glow/50 hover:text-text"
        >
          ← Tüm müşteriler
        </Link>
      ) : null}

      <ThemeSwitch />

      <div className="border-t border-border pt-3">
        <UserMenu user={user} links={links} placement="up" />
      </div>
    </div>
  );
}

/**
 * Müşteri paneli kabuğu (tasarım: "Fener Dashboard v2"). Geniş ekranda sabit
 * kenar çubuğu, dar ekranda üst çubuk + açılır menü. Yönetici görünümü ve
 * salt okunur hesap uyarıları içerik alanının üstünde durur.
 */
export function PanelShell({
  user,
  links,
  customerActive,
  children,
}: {
  user: Viewer;
  links: MenuLink[];
  customerActive: boolean;
  children: React.ReactNode;
}) {
  const { customerName, canWrite, isAdminView } = usePanel();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh flex-1">
      <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 overflow-y-auto border-r border-border bg-panel lg:block">
        <SidebarContent user={user} links={links} />
      </aside>

      {/* Dar ekran: üst çubuk + soldan açılan menü */}
      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menü">
          <div className="absolute inset-0 bg-[var(--scrim)]" onClick={() => setMenuOpen(false)} aria-hidden />
          <aside className="relative h-full w-[260px] max-w-[85vw] overflow-y-auto border-r border-border bg-panel">
            <SidebarContent user={user} links={links} onNavigate={() => setMenuOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-bg/85 px-4 py-3 backdrop-blur-md lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Menüyü aç"
            className="grid h-9 w-9 place-items-center rounded-[9px] border border-border bg-panel text-ink-2"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <BrandMark size={28} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[15px] font-bold text-text">Fener</span>
            <span className="block truncate text-[11.5px] text-muted">{customerName}</span>
          </span>
        </header>

        {isAdminView ? (
          <div className="border-b border-glow/30 bg-accent-soft px-4 py-2 text-xs text-text sm:px-6 lg:px-9">
            <span className="font-semibold text-accent">Sistem yöneticisi görünümü</span> ·{" "}
            <span className="font-medium">{customerName}</span> müşterisinin panelindesiniz. Yaptığınız
            her işlem bu müşteriye uygulanır ve kayda geçer.
            {customerActive ? null : (
              <span className="ml-1 font-semibold text-danger">(Müşteri pasif)</span>
            )}
          </div>
        ) : null}
        {!canWrite ? (
          <div className="border-b border-border bg-panel-2 px-4 py-2 text-xs text-muted sm:px-6 lg:px-9">
            <span className="font-semibold text-text">İzleyici hesabı.</span> Durumu ve
            ölçümleri izleyebilirsiniz; kontrol ve düzenleme için yöneticinize başvurun.
          </div>
        ) : null}

        <main className="w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-9 lg:py-7">
          {children}
        </main>
      </div>

      {/* Cihazın reddettiği komutların hata bildirimleri */}
      <ErrorToasts />
    </div>
  );
}
