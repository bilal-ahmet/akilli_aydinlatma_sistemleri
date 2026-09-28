import Link from "next/link";
import { TopBar } from "@/app/_components/TopBar";
import { PanelProvider, type PanelInfo } from "@/app/_lib/panel";
import { requireCustomerAccess } from "@/lib/auth/dal";
import { menuLinksFor, toViewer } from "@/lib/auth/menu";
import { canWrite } from "@/lib/auth/roles";
import { getTenancy } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

/**
 * Müşteri paneli kabuğu. Erişim burada doğrulanır (admin: her müşteri,
 * müşteri kullanıcısı: yalnızca kendisi, aksi halde 404). Panel içindeki
 * tüm istemci bileşenleri API çağrılarını `PanelProvider` üzerinden bu
 * müşteriye kapsamlar. Sunucu tarafında her API route'u ayrıca kontrol eder.
 */
export default async function CustomerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ customer: string }>;
}) {
  const { customer: slug } = await params;
  const { user, customer } = await requireCustomerAccess(slug);
  const isAdmin = user.role === "admin";

  const customers = isAdmin
    ? [...(await getTenancy()).customersById.values()]
        .map((c) => ({ slug: c.slug, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "tr"))
    : [];

  const panel: PanelInfo = {
    customerSlug: customer.slug,
    customerName: customer.name,
    role: user.role,
    canWrite: canWrite(user.role),
    isAdminView: isAdmin,
    customers,
  };

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        subtitle={customer.name}
        homeHref={`/c/${customer.slug}`}
        user={toViewer(user)}
        links={menuLinksFor(user, customer.slug)}
      />
      {isAdmin ? (
        <div className="border-b border-glow/30 bg-glow/10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs sm:px-6">
            <p className="text-text">
              <span className="font-semibold text-accent">Yönetici görünümü</span> ·{" "}
              <span className="font-medium">{customer.name}</span> müşterisinin panelindesiniz.
              Yaptığınız her işlem bu müşteriye uygulanır ve kayda geçer.
              {customer.isActive ? null : (
                <span className="ml-1 font-semibold text-danger">(Müşteri pasif)</span>
              )}
            </p>
            <Link href="/admin" className="font-semibold text-accent hover:underline">
              ← Müşteriler
            </Link>
          </div>
        </div>
      ) : null}
      {!panel.canWrite ? (
        <div className="border-b border-border bg-panel-2">
          <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-muted sm:px-6">
            <span className="font-semibold text-text">Salt okunur hesap.</span> Durumu ve
            telemetriyi izleyebilirsiniz; kontrol ve düzenleme için yöneticinize başvurun.
          </p>
        </div>
      ) : null}
      <PanelProvider value={panel}>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </PanelProvider>
      <footer className="border-t border-border/70 py-6 text-center text-xs text-muted">
        Fener · Akıllı Sokak Aydınlatma Sistemi
      </footer>
    </div>
  );
}
