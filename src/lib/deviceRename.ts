import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { ScheduleTarget } from "@/lib/scheduleTime";

/**
 * Yanlış girilmiş MAC'i düzeltir: cihaz satırı ve MAC'e bağlı bütün kayıtlar
 * yeni MAC'e taşınır (tek transaction). Çağıran; yeni MAC'in geçerli, başka
 * bir cihaz ya da gateway olarak kayıtlı olmadığını önceden doğrular.
 *
 * Kayıtsız MAC'in verisi de yazıldığı için (bkz. mqtt.ts), cihaz yanlış
 * MAC'le eklenmişse gerçek cihazın lamba/ölçüm kayıtları yeni MAC altında
 * zaten durur. Bu yüzden:
 *  - `fixtures`: yeni MAC'te aynı kanal varsa o satır (gerçek durum) kalır,
 *    eski satırın ismi yalnızca isimsiz satıra aktarılır; olmayan kanallar
 *    (elle eklenmiş lambalar) taşınır.
 *  - Geçmiş tabloları (`d4i_telemetry`, `device_status`, `fault_events`) ve
 *    cihaz komut logu (`commands`) taşınır; eski MAC'te hiçbir kayıt kalmaz
 *    (MAC başka müşteriye eklenirse geçmiş sızmasın — silme kuralıyla aynı).
 *  - Cihaz satırındaki son görülme, sağlık, sürüm ve gateway bağı sıfırlanır:
 *    eski MAC'e aittiler, yeni MAC'in ilk mesajıyla dolarlar.
 *  - Müşterinin zamanlamalarındaki hedefler yeni MAC'e çevrilir.
 */
export async function renameDeviceMac(oldMac: string, newMac: string, customerId: string | null) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE fixtures AS n SET name = o.name
      FROM fixtures AS o
      WHERE n.device_id = ${newMac} AND o.device_id = ${oldMac}
        AND n.channel = o.channel AND n.name IS NULL AND o.name IS NOT NULL`);
    await tx.execute(sql`
      DELETE FROM fixtures AS o
      WHERE o.device_id = ${oldMac}
        AND EXISTS (SELECT 1 FROM fixtures n WHERE n.device_id = ${newMac} AND n.channel = o.channel)`);
    await tx.update(schema.fixtures).set({ deviceId: newMac }).where(eq(schema.fixtures.deviceId, oldMac));

    await tx
      .update(schema.d4iTelemetry)
      .set({ deviceId: newMac })
      .where(eq(schema.d4iTelemetry.deviceId, oldMac));
    await tx
      .update(schema.deviceStatus)
      .set({ deviceId: newMac })
      .where(eq(schema.deviceStatus.deviceId, oldMac));
    await tx
      .update(schema.faultEvents)
      .set({ deviceId: newMac })
      .where(eq(schema.faultEvents.deviceId, oldMac));
    await tx
      .update(schema.commands)
      .set({ targetId: newMac })
      .where(and(eq(schema.commands.targetType, "device"), eq(schema.commands.targetId, oldMac)));

    await tx
      .update(schema.devices)
      .set({
        deviceId: newMac,
        lastSeen: null,
        lastError: null,
        lastErrorAt: null,
        firmwareVersion: null,
        health: null,
        healthAt: null,
        gatewayId: null,
      })
      .where(eq(schema.devices.deviceId, oldMac));

    if (customerId) {
      const rows = await tx
        .select({ id: schema.schedules.id, target: schema.schedules.target })
        .from(schema.schedules)
        .where(eq(schema.schedules.customerId, customerId));
      for (const r of rows) {
        const next = renameInTarget(r.target, oldMac, newMac);
        if (next) await tx.update(schema.schedules).set({ target: next }).where(eq(schema.schedules.id, r.id));
      }
    }
  });
}

/** Hedefte eski MAC varsa yeni MAC'li kopya, yoksa null. */
function renameInTarget(t: ScheduleTarget, oldMac: string, newMac: string): ScheduleTarget | null {
  if ("all" in t) return null;
  const uses = t.devices.includes(oldMac) || t.lamps.some((l) => l.mac === oldMac);
  if (!uses) return null;
  return {
    zones: t.zones,
    devices: t.devices.map((m) => (m === oldMac ? newMac : m)),
    lamps: t.lamps.map((l) => (l.mac === oldMac ? { ...l, mac: newMac } : l)),
  };
}
