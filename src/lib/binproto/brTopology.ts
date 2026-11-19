/**
 * Sayfalı Border Router topolojisini (BR_NEIGHBORS / BR_ROUTES) birleştirir.
 * Saf; sunucu globalThis'te tek örnek tutar (lib/mqtt.ts), test betiği
 * doğrudan sınar.
 *
 * Bir tur = aynı SNAPSHOT_ID'yi taşıyan sayfalar (PAGE 0'dan başlar, son
 * sayfada LAST_PAGE = 1). NEIGHBORS ve ROUTES aynı turda aynı SNAPSHOT_ID ile
 * gelir ama ayrı birleştirilir. Kurallar:
 *  - Paketler QoS 1'dir: aynı sayfa iki kez gelebilir, bir kez sayılır.
 *  - Sayfalar sırasız gelebilir; LAST_PAGE görülüp 0..son sayfaların hepsi
 *    gelince tur tamamdır.
 *  - Aynı gateway + tür için yeni bir tur başlarsa eskisinin yarımı atılır;
 *    hiç tamamlanmayan tur `ttlMs` sonra atılır.
 */
import type { BrNeighbor, BrRoute, BrTopologyKind, BrTopologyPage } from "./brToJson";

export interface BrTopologySnapshot {
  kind: BrTopologyKind;
  snapshotId: number | null;
  items: BrNeighbor[] | BrRoute[];
  /** Paketin bildirdiği toplam kayıt; null = bildirilmedi. */
  total: number | null;
  /** Toplanan kayıt sayısı TOTAL'den farklı (firmware hatası, uyarı loglanır). */
  mismatch: boolean;
}

type Pending = {
  kind: BrTopologyKind;
  snapshotId: number | null;
  pages: Map<number, BrNeighbor[] | BrRoute[]>;
  lastPage: number | null;
  total: number | null;
  startedAt: number;
};

export const TOPOLOGY_TTL_MS = 2 * 60_000;

export class TopologyAssembler {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = TOPOLOGY_TTL_MS) {}

  /** Sayfayı ekler; tur tamamlandıysa birleşik listeyi döner. */
  add(gatewayId: string, page: BrTopologyPage, now = Date.now()): BrTopologySnapshot | null {
    this.prune(now);
    const key = `${gatewayId}:${page.kind}`;
    let p = this.pending.get(key);
    if (!p || p.snapshotId !== page.snapshotId) {
      p = {
        kind: page.kind,
        snapshotId: page.snapshotId,
        pages: new Map(),
        lastPage: null,
        total: null,
        startedAt: now,
      };
      this.pending.set(key, p);
    }
    p.pages.set(page.page, page.items);
    if (page.total !== null) p.total = page.total;
    if (page.lastPage) p.lastPage = page.page;
    if (p.lastPage === null) return null;
    for (let i = 0; i <= p.lastPage; i++) if (!p.pages.has(i)) return null;

    this.pending.delete(key);
    const items: Array<BrNeighbor | BrRoute> = [];
    for (let i = 0; i <= p.lastPage; i++) items.push(...p.pages.get(i)!);
    return {
      kind: p.kind,
      snapshotId: p.snapshotId,
      items: items as BrNeighbor[] | BrRoute[],
      total: p.total,
      mismatch: p.total !== null && p.total !== items.length,
    };
  }

  /** Bekleyen (yarım) tur sayısı. */
  get size(): number {
    return this.pending.size;
  }

  /** Gateway silinince yarım turları unut. */
  forget(gatewayId: string): void {
    for (const key of this.pending.keys()) if (key.startsWith(`${gatewayId}:`)) this.pending.delete(key);
  }

  private prune(now: number): void {
    for (const [key, p] of this.pending) {
      if (now - p.startedAt > this.ttlMs) this.pending.delete(key);
    }
  }
}
