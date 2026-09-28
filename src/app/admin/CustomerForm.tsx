"use client";

import { useState } from "react";

export type CustomerFormValues = {
  name: string;
  slug?: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
};

const inputCls =
  "w-full rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-text outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
const labelCls = "mb-1 block text-xs font-medium text-muted";

/** Müşteri oluşturma/düzenleme formu. Kısa ad (slug) yalnızca oluştururken seçilir. */
export function CustomerForm({
  initial,
  submitting,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<CustomerFormValues>;
  submitting?: boolean;
  onSubmit: (values: CustomerFormValues) => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState("");
  const [contactName, setContactName] = useState(initial?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(initial?.contactEmail ?? "");
  const [contactPhone, setContactPhone] = useState(initial?.contactPhone ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      ...(editing || !slug.trim() ? {} : { slug: slug.trim() }),
      contactName: contactName.trim(),
      contactEmail: contactEmail.trim(),
      contactPhone: contactPhone.trim(),
      notes: notes.trim(),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label className={labelCls} htmlFor="cf-name">Müşteri adı *</label>
        <input id="cf-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn. İzmit Belediyesi" />
      </div>
      {!editing ? (
        <div>
          <label className={labelCls} htmlFor="cf-slug">Kısa ad (opsiyonel)</label>
          <input id="cf-slug" className={`${inputCls} font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="izmit-belediyesi" />
          <p className="mt-1 text-[11px] text-muted">
            Panel adresinde kullanılır (<code className="font-mono">/c/kisa-ad</code>). Boş bırakılırsa addan üretilir; sonradan değişmez.
          </p>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="cf-contact">İletişim kişisi</label>
          <input id="cf-contact" className={inputCls} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </div>
        <div>
          <label className={labelCls} htmlFor="cf-phone">Telefon</label>
          <input id="cf-phone" className={inputCls} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="cf-email">E-posta</label>
        <input id="cf-email" type="email" className={inputCls} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
      </div>
      <div>
        <label className={labelCls} htmlFor="cf-notes">Notlar</label>
        <textarea id="cf-notes" rows={3} className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="mt-1 flex justify-end gap-2">
        {onCancel ? (
          <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-text">
            İptal
          </button>
        ) : null}
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30 disabled:opacity-50"
        >
          {submitting ? "Kaydediliyor…" : editing ? "Kaydet" : "Oluştur"}
        </button>
      </div>
    </form>
  );
}
