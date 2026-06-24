/**
 * MAC adresi yardımcıları. Cihaz kimliği = MAC, iki noktasız ve büyük harf
 * (örn. "A8:42:E3:12:34:56" → "A842E3123456").
 */

/** Girdiyi normalize eder; geçerli 12 hane hex değilse null döner. */
export function normalizeMac(input: string): string | null {
  const hex = input.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex : null;
}

/** "A842E3123456" → "A8:42:E3:12:34:56" (gösterim için). */
export function formatMac(mac: string): string {
  return mac.match(/.{1,2}/g)?.join(":") ?? mac;
}
