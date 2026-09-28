import { asc, eq } from "drizzle-orm";
import { DashboardClient } from "@/app/_components/DashboardClient";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { requireCustomerAccess } from "@/lib/auth/dal";
import type { Zone } from "@/app/_lib/types";

// Her istekte güncel snapshot'ı DB'den oku (Kural #6).
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
    // DB henüz hazır değil — boş dashboard ile aç.
    return [];
  }
}

export default async function CustomerDashboard({
  params,
}: {
  params: Promise<{ customer: string }>;
}) {
  const { customer: slug } = await params;
  // Layout da kontrol eder; sayfa kendi verisini okumadan önce yeniden doğrular
  // (layout ve sayfa ayrı render edilebilir — Next.js DAL önerisi).
  const { customer } = await requireCustomerAccess(slug);
  const zones = await loadZones(customer.id);

  // key: admin müşteri değiştirdiğinde tüm istemci state'i sıfırlansın.
  return <DashboardClient key={customer.id} initialZones={zones} />;
}
