/**
 * Binary komutun kısa id'si (COMMAND_ID, u16 1..65535) ↔ komutun UUID'si
 * (commands.request_id). Saf; sunucu globalThis'te tek örnek tutar
 * (lib/mqtt.ts), test betiği doğrudan sınar.
 *
 * Sayaç backend genelinde TEK, cihaz başına değil: bölge komutu tek publish +
 * tek id ile çok cihaza gider, her cihaz aynı id ile kendi MAC topic'inden
 * yanıt verir (cihaz topic'ten, komut id'den bulunur). 10 dk'lık eşleşme
 * penceresinde 65535 değer dönmez; 1 bayt (256) zamanlamaların lamba başına
 * komutlarında dönebilirdi. Başlangıç rastgele: restart öncesinden gelen geç
 * ack'ler yeni komutlarla çakışmasın.
 */

export const SHORT_ID_MAX = 0xffff;

export class ShortIdTable {
  private nextId: number;
  private readonly map = new Map<number, { requestId: string; at: number }>();

  constructor(
    private readonly ttlMs: number,
    start = 1 + Math.floor(Math.random() * SHORT_ID_MAX),
  ) {
    this.nextId = start;
  }

  /** Yeni kısa id üretir ve UUID'ye bağlar. 0 hiç verilmez (= "id yok"). */
  issue(requestId: string, now = Date.now()): number {
    for (const [id, e] of this.map) {
      if (now - e.at > this.ttlMs) this.map.delete(id);
    }
    const id = this.nextId;
    this.nextId = id >= SHORT_ID_MAX ? 1 : id + 1;
    this.map.set(id, { requestId, at: now });
    return id;
  }

  /** Kısa id'nin UUID'si; süresi geçmişse ya da hiç verilmediyse undefined. */
  resolve(id: number, now = Date.now()): string | undefined {
    const e = this.map.get(id);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    return e.requestId;
  }

  get size(): number {
    return this.map.size;
  }
}
