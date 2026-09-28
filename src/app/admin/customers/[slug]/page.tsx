import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { TopBar } from "@/app/_components/TopBar";
import { UserManager } from "@/app/_components/UserManager";
import { db, schema } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/dal";
import { menuLinksFor, toViewer } from "@/lib/auth/menu";
import { getTenancy } from "@/lib/tenancy";
import type { AuditEntry } from "@/types/admin";
import { CustomerSettings } from "./CustomerSettings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Müşteri ayarları · Fener Yönetim",
};

export default async function CustomerSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await requireAdmin();
  const { slug } = await params;

  const [row] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.slug, slug))
    .limit(1);
  if (!row) notFound();

  const info = (await getTenancy()).customersById.get(row.id);
  const logs = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.customerId, row.id))
    .orderBy(desc(schema.auditLog.at))
    .limit(50);
  const audit: AuditEntry[] = logs.map((l) => ({
    id: l.id,
    at: l.at.toISOString(),
    username: l.username,
    action: l.action,
    target: l.target,
    detail: l.detail,
    ip: l.ip,
  }));

  return (
    <div className="flex flex-1 flex-col">
      <TopBar subtitle="Yönetim · müşteri ayarları" homeHref="/admin" user={toViewer(user)} links={menuLinksFor(user)} />
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/admin" className="text-xs font-medium text-accent hover:underline">
              ← Müşteriler
            </Link>
            <h1 className="mt-1 font-display text-2xl font-bold text-text">{row.name}</h1>
            <p className="font-mono text-xs text-muted">/c/{row.slug}</p>
          </div>
          <Link
            href={`/c/${row.slug}`}
            className="rounded-lg border border-glow/40 bg-glow/20 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-glow/30"
          >
            Paneli aç →
          </Link>
        </div>

        <CustomerSettings
          customer={{
            slug: row.slug,
            name: row.name,
            contactName: row.contactName ?? "",
            contactEmail: row.contactEmail ?? "",
            contactPhone: row.contactPhone ?? "",
            notes: row.notes ?? "",
            isActive: row.isActive,
          }}
          zoneCount={info?.zoneSlugs.length ?? 0}
          deviceCount={info?.macs.length ?? 0}
          audit={audit}
        />

        <UserManager customerSlug={row.slug} currentUserId={user.id} canManage />
      </main>
    </div>
  );
}
