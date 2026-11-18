import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { fitSlug, groupSlugBase, isReservedZoneSlug, slugify, withSuffix } from "@/lib/slug";

/**
 * Topic slug'ı (bölge ya da alt grup) kullanılabilir mi? Bölgeler, alt gruplar
 * ve emekli slug'lar AYNI ad alanıdır: hepsi `Meven:<slug>/cmd` topic'idir.
 */
async function topicSlugFree(slug: string): Promise<boolean> {
  if (isReservedZoneSlug(slug)) return false;
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, slug))
    .limit(1);
  if (zone) return false;
  const [group] = await db
    .select({ id: schema.zoneGroups.id })
    .from(schema.zoneGroups)
    .where(eq(schema.zoneGroups.slug, slug))
    .limit(1);
  if (group) return false;
  const [retired] = await db
    .select({ slug: schema.retiredZoneSlugs.slug })
    .from(schema.retiredZoneSlugs)
    .where(eq(schema.retiredZoneSlugs.slug, slug))
    .limit(1);
  return !retired;
}

/** Tabandan benzersiz topic slug'ı (≤32, çakışmada `-2`, `-3`… taban kısalır). */
async function allocateTopicSlug(base: string): Promise<string | null> {
  if (!base) return null;
  for (let i = 1; i < 1000; i++) {
    const slug = withSuffix(base, i);
    if (!slug) return null;
    if (await topicSlugFree(slug)) return slug;
  }
  return null;
}

/**
 * Yeni bölge için benzersiz slug üretir. Slug'lar tüm müşteriler arasında
 * GLOBAL benzersizdir (MQTT topic uzayı ortak) ve:
 *  - rezerv değerlere (bkz. isReservedZoneSlug) düşmez,
 *  - alt grup slug'larıyla çakışmaz,
 *  - silinmiş bir bölgenin / alt grubun slug'ını (retired_zone_slugs) yeniden
 *    kullanmaz — sahada o topic'i dinleyen cihazlar olabilir,
 *  - cihaza gönderildiği için en fazla 32 karakterdir (firmware sınırı).
 *
 * Çakışmada sonuna sayı eklenir (ataturk-bulvari → ataturk-bulvari-2).
 * Geçerli bir taban üretilemezse null.
 */
export async function allocateZoneSlug(input: string): Promise<string | null> {
  let base = fitSlug(slugify(input));
  if (!base) return null;
  if (isReservedZoneSlug(base)) base = fitSlug(`bolge-${base}`);
  return allocateTopicSlug(base);
}

/** Alt grup slug'ı: `<bölge>-<ad>`, bölgelerle aynı kurallar (bkz. groupSlugBase). */
export async function allocateGroupSlug(zoneSlug: string, name: string): Promise<string | null> {
  return allocateTopicSlug(groupSlugBase(zoneSlug, name));
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
