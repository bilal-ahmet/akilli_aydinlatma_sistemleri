import { asc } from "drizzle-orm";
import { TopBar } from "./_components/TopBar";
import { DashboardClient } from "./_components/DashboardClient";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import type { Zone } from "./_lib/types";

// Her istekte güncel snapshot'ı DB'den oku (Kural #6).
export const dynamic = "force-dynamic";

async function loadZones(): Promise<Zone[]> {
  try {
    const rows = await db
      .select()
      .from(schema.zones)
      .orderBy(asc(schema.zones.name));
    return rows.map(toZone);
  } catch {
    // DB henüz hazır/seed'lenmemiş olabilir — boş dashboard ile aç.
    return [];
  }
}

export default async function Home() {
  const zones = await loadZones();

  return (
    <div className="flex flex-1 flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <DashboardClient initialZones={zones} />
      </main>
      <footer className="border-t border-border/70 py-6 text-center text-xs text-muted">
        Fener · Akıllı Sokak Aydınlatma Sistemi
      </footer>
    </div>
  );
}
