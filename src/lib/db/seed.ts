import { config } from "dotenv";
config({ path: ".env.local" });

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { initialZones } from "@/app/_lib/mockData";
import * as schema from "./schema";

/**
 * Frontend mock'undaki 8 zone'u gerçek `zones` satırlarına çevirir ve her
 * zone için birkaç örnek `devices` kaydı oluşturur. Idempotent: önce temizler.
 *
 * Çalıştır:  npm run db:seed
 */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  // Temiz başlangıç (FK sırası önemli).
  await db.delete(schema.deviceStatus);
  await db.delete(schema.commands);
  await db.delete(schema.devices);
  await db.delete(schema.zones);

  for (const z of initialZones) {
    const [zoneRow] = await db
      .insert(schema.zones)
      .values({
        slug: z.id,
        name: z.name,
        district: z.district,
        poleCount: z.poleCount,
        isOn: z.isOn,
        brightness: z.brightness,
        status: z.status,
      })
      .returning();

    // Her zone için 3 örnek cihaz. Cihaz kimliği = MAC (iki noktasız);
    // demo için rastgele üretilir (gerçek cihazlar sahada kendi MAC'iyle gelir).
    const deviceCount = Math.min(3, z.poleCount);
    for (let i = 1; i <= deviceCount; i++) {
      await db.insert(schema.devices).values({
        deviceId: fakeMac(),
        zoneId: zoneRow.id,
        name: `${z.name} #${i}`,
      });
    }

    console.log(`✓ ${z.name} (${z.id}) + ${deviceCount} cihaz`);
  }

  await pool.end();
  console.log(`\nSeed tamam: ${initialZones.length} zone.`);
}

/** Demo için rastgele 12 hane hex MAC üretir (büyük harf, iki noktasız). */
function fakeMac(): string {
  return Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
}

main().catch((err) => {
  console.error("Seed hatası:", err);
  process.exit(1);
});
