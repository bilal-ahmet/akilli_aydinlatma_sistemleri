"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/app/_components/Modal";
import type { AuditEntry } from "@/types/admin";
import { CustomerForm, type CustomerFormValues } from "../../CustomerForm";

type Customer = {
  slug: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  isActive: boolean;
};

/** Denetim kaydı eylem kodlarının okunur karşılıkları. */
const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Giriş yaptı",
  "auth.login_failed": "Hatalı giriş denemesi",
  "auth.login_inactive": "Pasif hesapla giriş denemesi",
  "auth.password_change": "Şifresini değiştirdi",
  "customer.create": "Müşteri oluşturuldu",
  "customer.update": "Müşteri bilgileri güncellendi",
  "customer.delete": "Müşteri silindi",
  "zone.create": "Bölge eklendi",
  "zone.update": "Bölge güncellendi",
  "zone.move": "Bölge başka müşteriye taşındı",
  "zone.delete": "Bölge silindi",
  "device.create": "Cihaz eklendi",
  "device.create_conflict": "Başka hesaptaki MAC eklenmek istendi",
  "device.update": "Cihaz güncellendi",
  "device.delete": "Cihaz silindi",
  "user.create": "Kullanıcı oluşturuldu",
  "user.update": "Kullanıcı güncellendi",
  "user.password_reset": "Kullanıcı şifresi sıfırlandı",
  "user.delete": "Kullanıcı silindi",
};

export function CustomerSettings({
  customer,
  zoneCount,
  deviceCount,
  audit,
}: {
  customer: Customer;
  zoneCount: number;
  deviceCount: number;
  audit: AuditEntry[];
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(customer);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<"deactivate" | "delete" | null>(null);

  async function patch(body: Partial<CustomerFormValues> & { isActive?: boolean }) {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/admin/customers/${current.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Kaydedilemedi (${res.status})`);
      setCurrent((c) => ({ ...c, ...body }) as Customer);
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kaydedilemedi");
    } finally {
      setSubmitting(false);
      setConfirm(null);
    }
  }

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${current.slug}`, { method: "DELETE" });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error ?? `Silinemedi (${res.status})`);
      router.push("/admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Silinemedi");
      setSubmitting(false);
      setConfirm(null);
    }
  }

  return (
    <>
      <section className="rounded-2xl border border-border bg-panel p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold text-text">Müşteri bilgileri</h2>
          <p className="text-xs text-muted">
            {zoneCount} bölge · {deviceCount} cihaz
          </p>
        </div>
        {error ? (
          <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}
        {saved ? <p className="mb-3 text-xs text-accent">Kaydedildi.</p> : null}
        <CustomerForm
          key={current.name}
          initial={current}
          submitting={submitting}
          onSubmit={(v) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { slug: _slug, ...rest } = v;
            patch(rest);
          }}
        />
      </section>

      <section className="rounded-2xl border border-danger/30 bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-text">Hesap durumu</h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted">
            {current.isActive ? (
              <>
                Müşteri <span className="font-semibold text-accent">aktif</span>. Pasifleştirilirse kullanıcıları
                giriş yapamaz ve açık oturumları kapanır; cihazlar ve lambalar çalışmaya devam eder.
              </>
            ) : (
              <>
                Müşteri <span className="font-semibold text-danger">pasif</span>. Kullanıcıları giriş yapamaz.
              </>
            )}
          </p>
          <div className="flex gap-2">
            {current.isActive ? (
              <button type="button" onClick={() => setConfirm("deactivate")} className="rounded-lg border border-danger/40 px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger/10">
                Pasifleştir
              </button>
            ) : (
              <button type="button" disabled={submitting} onClick={() => patch({ isActive: true })} className="rounded-lg border border-glow/40 bg-glow/20 px-3 py-1.5 text-sm font-semibold text-text hover:bg-glow/30 disabled:opacity-50">
                Aktifleştir
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirm("delete")}
              disabled={zoneCount > 0}
              title={zoneCount > 0 ? "Önce bölgeleri taşıyın ya da silin" : undefined}
              className="rounded-lg border border-danger/40 bg-danger/15 px-3 py-1.5 text-sm font-semibold text-danger hover:bg-danger/25 disabled:opacity-40"
            >
              Sil
            </button>
          </div>
        </div>
        {zoneCount > 0 ? (
          <p className="mt-2 text-[11px] text-muted">
            Silmek için önce müşterinin bölgelerini başka müşteriye taşıyın (bölge düzenleme) ya da silin.
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-panel p-5">
        <h2 className="font-display text-lg font-semibold text-text">Son işlemler</h2>
        <p className="mt-1 text-xs text-muted">
          Bu müşterinin panelinde yapılan son 50 işlem (yönetici işlemleri dahil). Komutlar ayrıca
          komut kaydında tutulur.
        </p>
        {audit.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Kayıt yok.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                <span className="text-text">
                  {ACTION_LABELS[a.action] ?? a.action}
                  {a.target ? <span className="ml-1 font-mono text-xs text-muted">{a.target}</span> : null}
                </span>
                <span className="text-xs text-muted">
                  <span className="font-mono">{a.username ?? "—"}</span> ·{" "}
                  {new Date(a.at).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "delete" ? "Müşteriyi sil" : "Müşteriyi pasifleştir"}
      >
        <p className="text-sm text-muted">
          {confirm === "delete" ? (
            <>
              <span className="font-medium text-text">{current.name}</span> ve tüm kullanıcı hesapları
              kalıcı olarak silinecek.
            </>
          ) : (
            <>
              <span className="font-medium text-text">{current.name}</span> kullanıcıları giriş yapamayacak ve
              açık oturumları kapanacak. Aydınlatma çalışmaya devam eder.
            </>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => setConfirm(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
            İptal
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => (confirm === "delete" ? remove() : patch({ isActive: false }))}
            className="rounded-lg border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
          >
            {submitting ? "İşleniyor…" : confirm === "delete" ? "Sil" : "Pasifleştir"}
          </button>
        </div>
      </Modal>
    </>
  );
}
