import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { isReservedZoneSlug, slugify } from "@/lib/slug";

/**
 * Yeni bölge için benzersiz slug üretir. Slug'lar tüm müşteriler arasında
 * GLOBAL benzersizdir (MQTT topic uzayı ortak) ve:
 *  - rezerv değerlere (bkz. isReservedZoneSlug) düşmez,
 *  - silinmiş bir bölgenin slug'ını (retired_zone_slugs) yeniden kullanmaz —
 *    sahada o slug ile flaşlanmış cihazlar hâlâ o topic'i dinliyor olabilir.
 *
 * Çakışmada sonuna sayı eklenir (ataturk-bulvari → ataturk-bulvari-2).
 * Geçerli bir taban üretilemezse null.
 */
export async function allocateZoneSlug(input: string): Promise<string | null> {
  let base = slugify(input);
  if (!base) return null;
  if (isReservedZoneSlug(base)) base = `bolge-${base}`.slice(0, 95);

  for (let i = 1; i < 1000; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (isReservedZoneSlug(slug)) continue;
    const [taken] = await db
      .select({ id: schema.zones.id })
      .from(schema.zones)
      .where(eq(schema.zones.slug, slug))
      .limit(1);
    if (taken) continue;
    const [retired] = await db
      .select({ slug: schema.retiredZoneSlugs.slug })
      .from(schema.retiredZoneSlugs)
      .where(eq(schema.retiredZoneSlugs.slug, slug))
      .limit(1);
    if (retired) continue;
    return slug;
  }
  return null;
}

/** Müşteri slug'ı (URL: /c/<slug>) — yalnızca customers tablosunda benzersiz. */
export async function allocateCustomerSlug(input: string): Promise<string | null> {
  const base = slugify(input);
  if (!base) return null;
  for (let i = 1; i < 1000; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const [taken] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.slug, slug))
      .limit(1);
    if (!taken) return slug;
  }
  return null;
}
