import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Lamba ↔ ağ geçidi bağı (`devices.gateway_id`), Thread partition'ından.
 *
 * Binary 0x03'te gateway'e bağlı cihaz listesi (`nodes`) yok. Bunun yerine:
 * aynı Thread bölümündeki (partition) lambalar o bölümün Border Router'ı
 * üzerinden internete çıkar. Gateway'in health'indeki `thread.partition_id`
 * ile lambanın son health'indeki (`devices.health.thread.partition_id`) aynı
 * olan cihazlar gateway'e bağlanır. İkisi de ondalık metin olarak karşılaştırılır
 * (lambada JSON sayısı, gateway'de metin; `->>` ikisini de aynı metne çevirir).
 *
 * Kurallar:
 *  - Yalnızca gateway'in MÜŞTERİSİNİN cihazları bağlanır (Kural #12).
 *  - Aynı partition'ı bildiren başka bir gateway'e (aynı Thread ağında ikinci
 *    Border Router) zaten bağlı cihaza dokunulmaz — bağlar iki gateway arasında
 *    her health'te el değiştirmesin.
 *  - Partition'ı artık farklı olan ya da başka müşteriye geçmiş cihazın bu
 *    gateway'le bağı kaldırılır. Partition bilgisi olmayan cihazın (eski
 *    firmware, henüz health yok) bağı korunur.
 *  - Gateway'in partition'ı yoksa (Thread'e bağlı değil) hiçbir şey yapılmaz.
 *
 * Gateway health'i ~5 dk'da bir gelir ve satırı zaten yazılır; ek zamanlayıcı
 * yok. Yalnızca değişen satırlar yazılır.
 */
export async function linkDevicesByPartition(
  gatewayId: string,
  customerId: string,
  partitionId: string | null,
): Promise<{ linked: number; unlinked: number }> {
  if (!partitionId) return { linked: 0, unlinked: 0 };

  const linked = await db.execute(sql`
    UPDATE devices d SET gateway_id = ${gatewayId}
    FROM zones z
    WHERE d.zone_id = z.id
      AND z.customer_id = ${customerId}
      AND d.health -> 'thread' ->> 'partition_id' = ${partitionId}
      AND d.gateway_id IS DISTINCT FROM ${gatewayId}
      AND NOT EXISTS (
        SELECT 1 FROM gateways g2
        WHERE g2.gateway_id = d.gateway_id
          AND g2.customer_id = ${customerId}
          AND g2.health -> 'thread' ->> 'partition_id' = ${partitionId}
      )
  `);

  const unlinked = await db.execute(sql`
    UPDATE devices d SET gateway_id = NULL
    WHERE d.gateway_id = ${gatewayId}
      AND (
        (d.health -> 'thread' ->> 'partition_id' IS NOT NULL
          AND d.health -> 'thread' ->> 'partition_id' <> ${partitionId})
        OR NOT EXISTS (
          SELECT 1 FROM zones z WHERE z.id = d.zone_id AND z.customer_id = ${customerId}
        )
      )
  `);

  return { linked: linked.rowCount ?? 0, unlinked: unlinked.rowCount ?? 0 };
}
