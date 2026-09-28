import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, homePathFor } from "@/lib/auth/dal";
import { ThemeToggle } from "@/app/_components/ThemeToggle";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Giriş · Fener",
};

/** Yalnızca site içi yol kabul edilir (açık yönlendirme engeli). */
function safeNext(next: string | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (next.startsWith("/login") || next.startsWith("/api/")) return null;
  return next;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getSession();
  if (user) redirect(homePathFor(user));
  const { next } = await searchParams;

  return (
    <div className="relative flex min-h-full flex-1 items-center justify-center px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div
        className="glow-spill w-full max-w-sm rounded-3xl border border-border bg-panel p-7 sm:p-8"
        style={{ "--lvl": 0.55, "--spread": "60px" } as React.CSSProperties}
      >
        <div className="mb-7 flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-11 w-11 place-items-center rounded-2xl bg-glow/15 text-xl shadow-[0_0_24px_-4px_var(--glow)]"
          >
            💡
          </span>
          <div className="leading-tight">
            <h1 className="font-display text-xl font-bold tracking-tight text-text">Fener</h1>
            <p className="text-xs text-muted">Sokak Aydınlatma Kontrolü</p>
          </div>
        </div>

        <h2 className="font-display text-lg font-semibold text-text">Giriş yap</h2>
        <p className="mb-5 mt-1 text-sm text-muted">
          Size verilen kullanıcı adı ve şifre ile panelinize girin.
        </p>

        <LoginForm next={safeNext(next)} />
      </div>
    </div>
  );
}
