"use client";

import { useState } from "react";

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2.5 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

export function LoginForm({ next }: { next: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Giriş başarısız (${res.status})`);
      const target: string = j?.data?.redirect === "/hesap" ? "/hesap" : (next ?? "/");
      // Tam sayfa geçiş: sunucu bileşenleri yeni çerezle baştan render edilsin.
      window.location.href = target;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Giriş başarısız");
      setPassword("");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}
      <div>
        <label className={labelCls} htmlFor="login-username">Kullanıcı adı</label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          className={inputCls}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div>
        <label className={labelCls} htmlFor="login-password">Şifre</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button
        type="submit"
        disabled={submitting || !username.trim() || !password}
        className="mt-1 rounded-lg border border-glow/40 bg-glow/25 px-4 py-2.5 text-sm font-semibold text-text shadow-[0_0_18px_-6px_var(--glow)] transition-colors hover:bg-glow/35 disabled:opacity-50"
      >
        {submitting ? "Giriş yapılıyor…" : "Giriş yap"}
      </button>
      <p className="text-center text-[11px] text-muted">
        Şifrenizi mi unuttunuz? Yöneticinizden sıfırlamasını isteyin.
      </p>
    </form>
  );
}
