import type { Metadata } from "next";
import { TopBar } from "@/app/_components/TopBar";
import { requireAdmin } from "@/lib/auth/dal";
import { menuLinksFor, toViewer } from "@/lib/auth/menu";
import { listCustomerOverviews } from "@/lib/customers";
import type { CustomerOverview } from "@/types/admin";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Müşteriler · Fener Yönetim",
};

export default async function AdminPage() {
  const user = await requireAdmin();
  let customers: CustomerOverview[] = [];
  try {
    customers = await listCustomerOverviews();
  } catch (err) {
    console.error("[admin] müşteri listesi okunamadı:", err);
  }

  return (
    <div className="flex flex-1 flex-col">
      <TopBar
        subtitle="Yönetim · tüm müşteriler"
        homeHref="/admin"
        user={toViewer(user)}
        links={menuLinksFor(user)}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <AdminClient initialCustomers={customers} />
      </main>
      <footer className="border-t border-border/70 py-6 text-center text-xs text-muted">
        Fener · Yönetim paneli
      </footer>
    </div>
  );
}
