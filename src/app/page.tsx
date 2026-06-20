import { TopBar } from "./_components/TopBar";
import { DashboardClient } from "./_components/DashboardClient";
import { initialZones } from "./_lib/mockData";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <DashboardClient initialZones={initialZones} />
      </main>
      <footer className="border-t border-border/70 py-6 text-center text-xs text-muted">
        Fener · Akıllı Sokak Aydınlatma Sistemi — örnek veriyle çalışıyor
      </footer>
    </div>
  );
}
