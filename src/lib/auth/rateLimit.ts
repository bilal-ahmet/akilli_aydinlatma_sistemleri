import "server-only";

/**
 * Hatalı giriş sınırlayıcı — bellek içi (tek instance, Kural #8).
 * Anahtar `ip|kullanıcı`: aynı IP'den başka hesaplara deneme ayrı sayılır,
 * ama bir hesaba tek IP'den kaba kuvvet engellenir.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

type Entry = { failures: number; firstAt: number; lockedUntil: number };

const g = globalThis as unknown as { __fenerLoginLimiter?: Map<string, Entry> };
const store = (g.__fenerLoginLimiter ??= new Map<string, Entry>());

/** Kilitliyse kalan süre (sn), değilse 0. */
export function lockedFor(key: string): number {
  const e = store.get(key);
  if (!e) return 0;
  const left = e.lockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  let e = store.get(key);
  if (!e || now - e.firstAt > WINDOW_MS) e = { failures: 0, firstAt: now, lockedUntil: 0 };
  e.failures += 1;
  if (e.failures >= MAX_FAILURES) e.lockedUntil = now + LOCK_MS;
  store.set(key, e);

  // Bellek sızmasın: süresi dolmuş kayıtları ara sıra temizle.
  if (store.size > 5000) {
    for (const [k, v] of store) {
      if (now - v.firstAt > WINDOW_MS && v.lockedUntil < now) store.delete(k);
    }
  }
}

export function clearFailures(key: string): void {
  store.delete(key);
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}
