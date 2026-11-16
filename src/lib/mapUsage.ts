import "server-only";
import { like, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mapUsage } from "@/lib/db/schema";

/**
 * Google Maps kota koruması (uygulama içi, yumuşak sınır).
 *
 * Google her harita kurulumunu ("map load") faturalar; aylık ücretsiz bir kota
 * vardır. Buradaki sayaç, kota dolmadan haritayı OpenStreetMap'e (MapLibre)
 * çevirir: kullanıcı hata ekranı görmez, fatura çıkmaz. KESİN güvence bu
 * değildir — Google Cloud'daki "Map loads per day" kotasıdır; bu sayaç onun
 * altında kalacak şekilde ayarlanır.
 *
 * Sayaç gün (UTC) başına tutulur: hem günlük hem aylık sınır uygulanır.
 * Tüm müşteriler ortaktır (Google anahtar başına faturalar).
 */

const DEFAULT_DAILY = 250;
const DEFAULT_MONTHLY = 8000;

function limitFrom(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function googleMapsLimits(): { daily: number; monthly: number } {
  return {
    daily: limitFrom("GOOGLE_MAPS_DAILY_LIMIT", DEFAULT_DAILY),
    monthly: limitFrom("GOOGLE_MAPS_MONTHLY_LIMIT", DEFAULT_MONTHLY),
  };
}

/** Anahtar ve Map ID tanımlı mı? Değilse Google hiç denenmez. */
export function googleMapsConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() && process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim(),
  );
}

function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

async function monthTotal(day: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${mapUsage.googleLoads}), 0)::int` })
    .from(mapUsage)
    .where(like(mapUsage.day, `${day.slice(0, 7)}-%`));
  return row?.total ?? 0;
}

/**
 * Bir Google harita kurulumu için hak ister. true → sayaç artırıldı, Google
 * kullanılabilir. false → sınır dolu / yapılandırılmamış / DB hatası (güvenli
 * taraf: OpenStreetMap).
 *
 * Günlük sınır atomiktir (tek INSERT … ON CONFLICT … WHERE). Aylık toplam ayrı
 * okunur; eşzamanlı isteklerde birkaç yükleme taşabilir — sınırlar ücretsiz
 * kotanın altında bırakıldığı için sorun değildir.
 */
export async function claimGoogleMapLoad(): Promise<boolean> {
  if (!googleMapsConfigured()) return false;
  const { daily, monthly } = googleMapsLimits();
  if (daily <= 0 || monthly <= 0) return false;
  const day = today();
  try {
    if ((await monthTotal(day)) >= monthly) return false;
    const rows = await db
      .insert(mapUsage)
      .values({ day, googleLoads: 1 })
      .onConflictDoUpdate({
        target: mapUsage.day,
        set: { googleLoads: sql`${mapUsage.googleLoads} + 1` },
        setWhere: lt(mapUsage.googleLoads, daily),
      })
      .returning({ loads: mapUsage.googleLoads });
    return rows.length > 0;
  } catch (err) {
    console.warn("[mapUsage] sayaç okunamadı, OpenStreetMap kullanılacak:", err);
    return false;
  }
}

export interface MapUsageSnapshot {
  configured: boolean;
  today: number;
  dailyLimit: number;
  month: number;
  monthlyLimit: number;
}

/** Admin sayfası için kullanım özeti. */
export async function mapUsageSnapshot(): Promise<MapUsageSnapshot> {
  const { daily, monthly } = googleMapsLimits();
  const day = today();
  const [row] = await db
    .select({ loads: mapUsage.googleLoads })
    .from(mapUsage)
    .where(sql`${mapUsage.day} = ${day}`);
  return {
    configured: googleMapsConfigured(),
    today: row?.loads ?? 0,
    dailyLimit: daily,
    month: await monthTotal(day),
    monthlyLimit: monthly,
  };
}
