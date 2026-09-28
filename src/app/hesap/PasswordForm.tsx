"use client";

import { useState } from "react";
import { PASSWORD_MIN } from "@/lib/auth/roles";

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = repeat.length > 0 && next !== repeat;
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN;
  const canSubmit = current && next.length >= PASSWORD_MIN && next === repeat && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Şifre değiştirilemedi (${res.status})`);
      setDone(true);
      // Zorunlu değişimden sonra kullanıcının açılış sayfasına geç.
      setTimeout(() => {
        window.location.href = "/";
      }, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Şifre değiştirilemedi");
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p className="mt-4 rounded-lg border border-glow/40 bg-glow/10 px-3 py-2 text-sm text-text">
        Şifreniz değiştirildi. Yönlendiriliyorsunuz…
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
      {error ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <label className={labelCls} htmlFor="pw-current">Mevcut şifre</label>
        <input id="pw-current" type="password" autoComplete="current-password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div>
        <label className={labelCls} htmlFor="pw-new">Yeni şifre</label>
        <input id="pw-new" type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} />
        <p className={`mt-1 text-[11px] ${tooShort ? "text-danger" : "text-muted"}`}>
          En az {PASSWORD_MIN} karakter.
        </p>
      </div>
      <div>
        <label className={labelCls} htmlFor="pw-repeat">Yeni şifre (tekrar)</label>
        <input id="pw-repeat" type="password" autoComplete="new-password" className={inputCls} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {mismatch ? <p className="mt-1 text-[11px] text-danger">Şifreler eşleşmiyor.</p> : null}
      </div>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
        >
          {submitting ? "Kaydediliyor…" : "Şifreyi değiştir"}
        </button>
      </div>
    </form>
  );
}
