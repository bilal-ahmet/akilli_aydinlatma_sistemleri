import "server-only";
import { like, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mapUsage } from "@/lib/db/schema";

/**
 * Google Maps kota koruması (uygulama içi, yumuşak sınır).
 *
 * Google her harita kurulumunu ("map load") ve her rota isteğini (Routes API)
 * ayrı faturalar; ikisinin de aylık ücretsiz kotası vardır. Buradaki sayaçlar
 * kota dolmadan Google'ı bırakır: harita OpenStreetMap'e (MapLibre) düşer, yol
 * tarifi dış "Google Haritalar'da aç" bağlantısına. Kullanıcı hata ekranı
 * görmez, fatura çıkmaz. KESİN güvence bu değildir — Google Cloud'daki günlük
 * kotalardır; bu sayaçlar onların altında kalacak şekilde ayarlanır.
 *
 * Sayaç gün (UTC) başına tutulur: hem günlük hem aylık sınır uygulanır.
 * Tüm müşteriler ortaktır (Google anahtar başına faturalar).
 */

export type GoogleUsageKind = "load" | "route";

const COLUMN = {
  load: mapUsage.googleLoads,
  route: mapUsage.routeRequests,
} as const;

const DEFAULTS: Record<GoogleUsageKind, { daily: number; monthly: number; env: string }> = {
  load: { daily: 250, monthly: 8000, env: "GOOGLE_MAPS" },
  // Compute Routes Essentials: 10k/ay ücretsiz; yarısında kalınır.
  route: { daily: 100, monthly: 5000, env: "GOOGLE_ROUTES" },
};

function limitFrom(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function googleUsageLimits(kind: GoogleUsageKind): { daily: number; monthly: number } {
  const d = DEFAULTS[kind];
  return {
    daily: limitFrom(`${d.env}_DAILY_LIMIT`, d.daily),
    monthly: limitFrom(`${d.env}_MONTHLY_LIMIT`, d.monthly),
  };
}

export function googleMapsLimits(): { daily: number; monthly: number } {
  return googleUsageLimits("load");
}

/** Anahtar ve Map ID tanımlı mı? Değilse Google hiç denenmez. */
export function googleMapsConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() && process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim(),
  );
}

/**
 * Routes API sunucu anahtarı tanımlı mı? Tarayıcı anahtarı (referrer kısıtlı)
 * sunucudan kullanılamaz; ayrı, yalnızca Routes API'ye kısıtlı anahtar gerekir.
 */
export function googleRoutesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_ROUTES_API_KEY?.trim());
}

function configured(kind: GoogleUsageKind): boolean {
  return kind === "load" ? googleMapsConfigured() : googleRoutesConfigured();
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function monthTotal(kind: GoogleUsageKind, day: string): Promise<number> {
  const col = COLUMN[kind];
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${col}), 0)::int` })
    .from(mapUsage)
    .where(like(mapUsage.day, `${day.slice(0, 7)}-%`));
  return row?.total ?? 0;
}

/**
 * Bir Google kullanımı (harita kurulumu ya da rota isteği) için hak ister.
 * true → sayaç artırıldı, Google kullanılabilir. false → sınır dolu /
 * yapılandırılmamış / DB hatası (güvenli taraf: Google kullanılmaz).
 *
 * Günlük sınır atomiktir (tek INSERT … ON CONFLICT … WHERE). Aylık toplam ayrı
 * okunur; eşzamanlı isteklerde birkaç istek taşabilir — sınırlar ücretsiz
 * kotanın altında bırakıldığı için sorun değildir.
 */
export async function claimGoogleUsage(kind: GoogleUsageKind): Promise<boolean> {
  if (!configured(kind)) return false;
  const { daily, monthly } = googleUsageLimits(kind);
  if (daily <= 0 || monthly <= 0) return false;
  const col = COLUMN[kind];
  const day = today();
  try {
    if ((await monthTotal(kind, day)) >= monthly) return false;
    const rows = await db
      .insert(mapUsage)
      .values(kind === "load" ? { day, googleLoads: 1 } : { day, routeRequests: 1 })
      .onConflictDoUpdate({
        target: mapUsage.day,
        set: kind === "load" ? { googleLoads: sql`${col} + 1` } : { routeRequests: sql`${col} + 1` },
        setWhere: lt(col, daily),
      })
      .returning({ n: col });
    return rows.length > 0;
  } catch (err) {
    console.warn(`[mapUsage] sayaç okunamadı (${kind}), Google kullanılmayacak:`, err);
    return false;
  }
}

/** Bir Google harita kurulumu için hak ister (bkz. `claimGoogleUsage`). */
export function claimGoogleMapLoad(): Promise<boolean> {
  return claimGoogleUsage("load");
}

export interface UsageCounter {
  configured: boolean;
  today: number;
  dailyLimit: number;
  month: number;
  monthlyLimit: number;
}

export interface MapUsageSnapshot extends UsageCounter {
  /** Yol tarifi (Routes API) sayacı. */
  routes: UsageCounter;
}

/** Admin sayfası için kullanım özeti. */
export async function mapUsageSnapshot(): Promise<MapUsageSnapshot> {
  const day = today();
  const [row] = await db
    .select({ loads: mapUsage.googleLoads, routes: mapUsage.routeRequests })
    .from(mapUsage)
    .where(sql`${mapUsage.day} = ${day}`);
  const load = googleUsageLimits("load");
  const route = googleUsageLimits("route");
  return {
    configured: googleMapsConfigured(),
    today: row?.loads ?? 0,
    dailyLimit: load.daily,
    month: await monthTotal("load", day),
    monthlyLimit: load.monthly,
    routes: {
      configured: googleRoutesConfigured(),
      today: row?.routes ?? 0,
      dailyLimit: route.daily,
      month: await monthTotal("route", day),
      monthlyLimit: route.monthly,
    },
  };
}
