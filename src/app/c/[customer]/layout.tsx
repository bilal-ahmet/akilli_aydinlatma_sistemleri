import { asc, eq } from "drizzle-orm";
import { PanelShell } from "@/app/_components/PanelShell";
import { DialogsProvider } from "@/app/_components/PanelDialogs";
import { PanelProvider, type PanelInfo } from "@/app/_lib/panel";
import { LightingProvider } from "@/app/_lib/lighting";
import type { Zone } from "@/app/_lib/types";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { requireCustomerAccess } from "@/lib/auth/dal";
import { panelMenuLinks, toViewer } from "@/lib/auth/menu";
import { canWrite } from "@/lib/auth/roles";
import { getTenancy } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

async function loadZones(customerId: string): Promise<Zone[]> {
  try {
    const rows = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.customerId, customerId))
      .orderBy(asc(schema.zones.name));
    return rows.map(toZone);
  } catch {
    // DB henüz hazır değil — boş panel ile aç.
    return [];
  }
}

/**
 * Müşteri paneli kabuğu. Erişim burada doğrulanır (admin: her müşteri,
 * müşteri kullanıcısı: yalnızca kendisi, aksi halde 404). Panel içindeki
 * tüm istemci bileşenleri API çağrılarını `PanelProvider` üzerinden bu
 * müşteriye kapsamlar. Sunucu tarafında her API route'u ayrıca kontrol eder.
 *
 * Bölge snapshot'ı burada DB'den okunur (Kural #6) ve `LightingProvider`'a
 * verilir; sayfalar arasında gezinirken canlı state korunur.
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

  const zones = await loadZones(customer.id);

  return (
    <PanelProvider value={panel}>
      {/* key: admin müşteri değiştirdiğinde tüm istemci state'i sıfırlansın. */}
      <LightingProvider key={customer.id} initialZones={zones}>
        <DialogsProvider>
          <PanelShell
            user={toViewer(user)}
            links={panelMenuLinks(user)}
            customerActive={customer.isActive}
          >
            {children}
          </PanelShell>
        </DialogsProvider>
      </LightingProvider>
    </PanelProvider>
  );
}
