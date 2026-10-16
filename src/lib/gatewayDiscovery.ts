import "server-only";

/**
 * Keşfedilen (kayıtsız) gateway'ler — bellek içi. Payload'ı gateway türü
 * taşıyan ama `gateways` tablosunda olmayan GW_ID'ler burada tutulur; admin
 * `/admin`'deki listeden bir müşteriye kaydeder. Kayıtsız gateway'in verisi
 * DB'ye yazılmaz (kayıtsız MAC telemetrisiyle aynı ilke: hiçbir müşteriye ait
 * değildir).
 *
 * Process yeniden başlayınca liste boşalır; gateway ~30 sn içinde yeniden
 * görünür. Tek instance varsayımı (Kural #8).
 */

export interface DiscoveredGateway {
  gatewayId: string;
  type: string | null;
  firmwareVersion: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** Bu süredir sessiz kalan kayıtsız gateway listeden düşer. */
const TTL_MS = 24 * 60 * 60_000;
/** Sahte/çok sayıda ID'ye karşı üst sınır. */
const MAX_ENTRIES = 500;

const g = globalThis as unknown as { __fenerGwDiscovered?: Map<string, DiscoveredGateway> };
const seen = (g.__fenerGwDiscovered ??= new Map());

export function noteDiscoveredGateway(
  gatewayId: string,
  info: { type: string | null; firmwareVersion: string | null },
  now: Date,
): void {
  const at = now.toISOString();
  const prev = seen.get(gatewayId);
  if (!prev && seen.size >= MAX_ENTRIES) prune(now.getTime());
  if (!prev && seen.size >= MAX_ENTRIES) return;
  seen.set(gatewayId, {
    gatewayId,
    type: info.type ?? prev?.type ?? null,
    firmwareVersion: info.firmwareVersion ?? prev?.firmwareVersion ?? null,
    firstSeen: prev?.firstSeen ?? at,
    lastSeen: at,
  });
}

/** Kayıt sonrası listeden çıkar. */
export function forgetDiscoveredGateway(gatewayId: string): void {
  seen.delete(gatewayId);
}

function prune(now: number): void {
  for (const [id, d] of seen) {
    if (now - new Date(d.lastSeen).getTime() > TTL_MS) seen.delete(id);
  }
}

/** Son görülme sırasıyla (yeni önce); `isRegistered` ile kayıtlılar süzülür. */
export function listDiscoveredGateways(isRegistered: (id: string) => boolean): DiscoveredGateway[] {
  prune(Date.now());
  return [...seen.values()]
    .filter((d) => !isRegistered(d.gatewayId))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
