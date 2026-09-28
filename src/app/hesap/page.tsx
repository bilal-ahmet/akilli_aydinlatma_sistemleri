import type { Metadata } from "next";
import { TopBar } from "@/app/_components/TopBar";
import { requireUser } from "@/lib/auth/dal";
import { menuLinksFor, toViewer } from "@/lib/auth/menu";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { PasswordForm } from "./PasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hesabım · Fener",
};

export default async function AccountPage() {
  const user = await requireUser({ allowMustChange: true });

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        subtitle={user.customer?.name ?? "Yönetim"}
        user={toViewer(user)}
        links={user.mustChangePassword ? [] : menuLinksFor(user)}
      />
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-2xl font-bold text-text">Hesabım</h1>

        <div className="mt-5 rounded-2xl border border-border bg-panel p-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Kullanıcı adı</dt>
            <dd className="font-mono text-text">{user.username}</dd>
            {user.displayName ? (
              <>
                <dt className="text-muted">Ad</dt>
                <dd className="text-text">{user.displayName}</dd>
              </>
            ) : null}
            <dt className="text-muted">Rol</dt>
            <dd className="text-text">{ROLE_LABELS[user.role]}</dd>
            {user.customer ? (
              <>
                <dt className="text-muted">Müşteri</dt>
                <dd className="text-text">{user.customer.name}</dd>
              </>
            ) : null}
          </dl>
        </div>

        <div className="mt-5 rounded-2xl border border-border bg-panel p-5">
          <h2 className="font-display text-lg font-semibold text-text">Şifre değiştir</h2>
          {user.mustChangePassword ? (
            <p className="mt-2 rounded-lg border border-accent/40 bg-glow/10 px-3 py-2 text-xs text-text">
              <span className="font-semibold text-accent">Devam etmeden önce şifrenizi değiştirin.</span>{" "}
              Hesabınız size geçici bir şifreyle verildi.
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              Şifre değişince diğer cihazlardaki oturumlarınız kapanır.
            </p>
          )}
          <PasswordForm />
        </div>
      </main>
    </div>
  );
}
