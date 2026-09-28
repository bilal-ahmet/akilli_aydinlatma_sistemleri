"use client";

import { useCallback, useEffect, useState } from "react";
import { CUSTOMER_ROLES, PASSWORD_MIN, ROLE_LABELS, type CustomerRole } from "@/lib/auth/roles";
import type { CustomerUser } from "@/types/admin";
import { Modal } from "./Modal";

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const btnPrimary =
  "rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text";

/** Karışabilen karakterler (0/O, 1/l/I) olmadan rastgele geçici şifre. */
function generatePassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function formatDate(iso: string | null): string {
  if (!iso) return "hiç";
  return new Date(iso).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
}

type Form =
  | { mode: "create" }
  | { mode: "edit"; user: CustomerUser }
  | { mode: "reset"; user: CustomerUser };

/**
 * Bir müşterinin panel kullanıcıları. Admin (müşteri ayarları sayfası) ve
 * müşteri yöneticisi (/c/<slug>/kullanicilar) aynı bileşeni kullanır; yetki
 * sunucuda kontrol edilir (authorizeCustomerManage).
 *
 * Yeni kullanıcı ve şifre sıfırlamada verilen şifre GEÇİCİDİR: kullanıcı ilk
 * girişte değiştirmek zorundadır. Şifre yalnızca bu ekranda bir kez görünür.
 */
export function UserManager({
  customerSlug,
  currentUserId,
  canManage,
}: {
  customerSlug: string;
  currentUserId: string;
  canManage: boolean;
}) {
  const base = `/api/customers/${encodeURIComponent(customerSlug)}/users`;
  const [users, setUsers] = useState<CustomerUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<Form | null>(null);
  const [deleting, setDeleting] = useState<CustomerUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Oluşturma/sıfırlama sonrası bir kez gösterilen geçici şifre. */
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null);

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<CustomerRole>("manager");
  const [password, setPassword] = useState("");
  const [isActive, setIsActive] = useState(true);

  const load = useCallback(() => {
    fetch(base)
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.data)) setUsers(j.data as CustomerUser[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setUsername("");
    setDisplayName("");
    setRole("manager");
    setPassword(generatePassword());
    setError(null);
    setForm({ mode: "create" });
  }
  function openEdit(u: CustomerUser) {
    setDisplayName(u.displayName ?? "");
    setRole(u.role);
    setIsActive(u.isActive);
    setError(null);
    setForm({ mode: "edit", user: u });
  }
  function openReset(u: CustomerUser) {
    setPassword(generatePassword());
    setError(null);
    setForm({ mode: "reset", user: u });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      if (form.mode === "create") {
        res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: username.trim(),
            displayName: displayName.trim() || undefined,
            role,
            password,
          }),
        });
      } else {
        const self = form.user.id === currentUserId;
        const body =
          form.mode === "reset"
            ? { password }
            : {
                displayName: displayName.trim(),
                ...(self ? {} : { role, isActive }),
              };
        res = await fetch(`${base}/${form.user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `İşlem başarısız (${res.status})`);
      const saved = j.data as CustomerUser;
      setUsers((us) =>
        (form.mode === "create" ? [...us, saved] : us.map((u) => (u.id === saved.id ? saved : u))).sort(
          (a, b) => a.username.localeCompare(b.username),
        ),
      );
      if (form.mode !== "edit") setIssued({ username: saved.username, password });
      setForm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "İşlem başarısız");
    } finally {
      setSubmitting(false);
    }
  }

  async function doDelete() {
    if (!deleting) return;
    const target = deleting;
    setSubmitting(true);
    try {
      const res = await fetch(`${base}/${target.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? "Kullanıcı silinemedi");
      setUsers((us) => us.filter((u) => u.id !== target.id));
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kullanıcı silinemedi");
    } finally {
      setSubmitting(false);
    }
  }

  const editingSelf = form?.mode === "edit" && form.user.id === currentUserId;

  return (
    <section aria-label="Kullanıcılar">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg font-bold text-text">Kullanıcılar</h2>
          <p className="text-xs text-muted">{users.length} hesap</p>
        </div>
        {canManage ? (
          <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-glow/30">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Yeni kullanıcı
          </button>
        ) : null}
      </div>

      {issued ? (
        <div className="mb-3 rounded-xl border border-glow/40 bg-glow/10 p-4 text-sm text-text">
          <p>
            <span className="font-semibold">{issued.username}</span> için geçici şifre:{" "}
            <code className="select-all rounded bg-panel-2 px-2 py-0.5 font-mono text-accent">{issued.password}</code>
          </p>
          <p className="mt-1 text-xs text-muted">
            Bu şifre yalnızca şimdi gösteriliyor. Kullanıcıya güvenli bir kanaldan iletin; ilk girişte
            değiştirmesi istenecek.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(issued.password).catch(() => {})}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text hover:border-glow/40"
            >
              Kopyala
            </button>
            <button type="button" onClick={() => setIssued(null)} className="rounded-md px-2.5 py-1 text-xs text-muted hover:text-text">
              Kapat
            </button>
          </div>
        </div>
      ) : null}

      {error && !form ? (
        <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border bg-panel">
        {loading ? (
          <p className="p-5 text-sm text-muted">Yükleniyor…</p>
        ) : users.length === 0 ? (
          <p className="p-5 text-sm text-muted">
            Bu müşterinin henüz kullanıcısı yok.{canManage ? " “Yeni kullanıcı” ile ilk hesabı açın." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-text">{u.username}</span>
                    {u.displayName ? <span className="text-sm text-muted">· {u.displayName}</span> : null}
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${u.role === "manager" ? "bg-glow/20 text-accent" : "bg-panel-2 text-muted"}`}>
                      {u.role === "manager" ? "Yönetici" : "İzleyici"}
                    </span>
                    {!u.isActive ? (
                      <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold text-danger">pasif</span>
                    ) : null}
                    {u.mustChangePassword ? (
                      <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">şifre değişimi bekliyor</span>
                    ) : null}
                    {u.id === currentUserId ? (
                      <span className="text-[10px] text-muted">(siz)</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">Son giriş: {formatDate(u.lastLoginAt)}</p>
                </div>
                {canManage ? (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => openEdit(u)} className="rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-glow/10 hover:text-text">
                      Düzenle
                    </button>
                    <button type="button" onClick={() => openReset(u)} className="rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-glow/10 hover:text-text">
                      Şifre sıfırla
                    </button>
                    {u.id !== currentUserId ? (
                      <button type="button" onClick={() => { setError(null); setDeleting(u); }} className="rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-danger/15 hover:text-danger">
                        Sil
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-2 text-[11px] text-muted">
        <span className="font-medium text-text">Yönetici</span>: bölge, cihaz, lamba ve kullanıcıları yönetir, komut verir.{" "}
        <span className="font-medium text-text">İzleyici</span>: yalnızca durumu ve telemetriyi görür.
      </p>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={
          form?.mode === "create"
            ? "Yeni kullanıcı"
            : form?.mode === "reset"
              ? "Şifre sıfırla"
              : "Kullanıcıyı düzenle"
        }
        subtitle={form && form.mode !== "create" ? <span className="font-mono text-xs">{form.user.username}</span> : undefined}
      >
        {error ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <form onSubmit={submit} className="flex flex-col gap-4">
          {form?.mode === "create" ? (
            <div>
              <label className={labelCls} htmlFor="um-username">Kullanıcı adı *</label>
              <input
                id="um-username"
                className={`${inputCls} font-mono`}
                value={username}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                placeholder="orn. ahmet.yilmaz"
              />
              <p className="mt-1 text-[11px] text-muted">3-64 karakter: küçük harf, rakam, nokta, alt çizgi, tire.</p>
            </div>
          ) : null}

          {form?.mode !== "reset" ? (
            <div>
              <label className={labelCls} htmlFor="um-name">Ad soyad (opsiyonel)</label>
              <input id="um-name" className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
          ) : null}

          {form?.mode !== "reset" && !editingSelf ? (
            <div>
              <label className={labelCls} htmlFor="um-role">Rol *</label>
              <select id="um-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value as CustomerRole)}>
                {CUSTOMER_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
          ) : null}

          {form?.mode === "edit" && !editingSelf ? (
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Hesap aktif (pasif hesap giriş yapamaz)
            </label>
          ) : null}
          {editingSelf ? (
            <p className="text-[11px] text-muted">Kendi rolünüzü ve aktifliğinizi değiştiremezsiniz.</p>
          ) : null}

          {form?.mode === "create" || form?.mode === "reset" ? (
            <div>
              <label className={labelCls} htmlFor="um-password">Geçici şifre *</label>
              <div className="flex gap-2">
                <input id="um-password" className={`${inputCls} font-mono`} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" onClick={() => setPassword(generatePassword())} className="shrink-0 rounded-lg border border-border px-3 text-xs font-medium text-muted hover:text-text">
                  Üret
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                En az {PASSWORD_MIN} karakter. Kullanıcı ilk girişte değiştirmek zorunda.
                {form?.mode === "reset" ? " Kullanıcının açık oturumları kapanır." : ""}
              </p>
            </div>
          ) : null}

          <div className="mt-1 flex justify-end gap-2">
            <button type="button" onClick={() => setForm(null)} className={btnGhost}>İptal</button>
            <button
              type="submit"
              disabled={
                submitting ||
                (form?.mode === "create" && (!username.trim() || password.length < PASSWORD_MIN)) ||
                (form?.mode === "reset" && password.length < PASSWORD_MIN)
              }
              className={btnPrimary}
            >
              {submitting ? "Kaydediliyor…" : form?.mode === "create" ? "Oluştur" : form?.mode === "reset" ? "Sıfırla" : "Kaydet"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={deleting !== null} onClose={() => setDeleting(null)} title="Kullanıcı sil">
        <p className="text-sm text-muted">
          <span className="font-mono text-text">{deleting?.username}</span> kullanıcısını silmek istediğinize
          emin misiniz? Geçici olarak engellemek için silmek yerine pasifleştirebilirsiniz.
        </p>
        {error ? (
          <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setDeleting(null)} className={btnGhost}>İptal</button>
          <button type="button" onClick={doDelete} disabled={submitting} className="rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50">
            {submitting ? "Siliniyor…" : "Sil"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
