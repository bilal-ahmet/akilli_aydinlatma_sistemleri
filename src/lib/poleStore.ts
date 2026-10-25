import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toPoleView } from "@/lib/adapters";
import { normalizeMac } from "@/lib/mac";
import type { PoleRow } from "@/lib/db/schema";
import type { PoleView } from "@/app/_lib/types";

/**
 * Direk kayıtlarının sunucu tarafı: liste, sahiplik, numara benzersizliği ve
 * cihaz bağlama kuralları. Route'lar (`/api/poles*`, cihaz PATCH) bu
 * fonksiyonlardan geçer — kurallar tek yerde kalsın.
 *
 * Kurallar:
 *  - Direk numarası (`code`) müşteri içinde benzersiz (büyük/küçük harf duyarsız).
 *  - Bir direkte en fazla bir cihaz; bir cihaz en fazla bir direkte
 *    (`devices.pole_id` UNIQUE).
 *  - Cihaz ile direk aynı bölgede olmalı.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** "K-2" < "K-10": numaralar doğal sırayla. */
const collator = new Intl.Collator("tr", { numeric: true, sensitivity: "base" });

/** Müşterinin direkleri (bölge + bağlı cihazla). `zoneSlug` / `poleId` süzer. */
export async function listPoles(
  customerId: string,
  opts: { zoneSlug?: string; poleId?: string } = {},
): Promise<PoleView[]> {
  const rows = await db
    .select({
      p: schema.poles,
      zoneSlug: schema.zones.slug,
      zoneName: schema.zones.name,
      deviceId: schema.devices.deviceId,
    })
    .from(schema.poles)
    .innerJoin(schema.zones, eq(schema.poles.zoneId, schema.zones.id))
    .leftJoin(schema.devices, eq(schema.devices.poleId, schema.poles.id))
    .where(
      and(
        eq(schema.zones.customerId, customerId),
        opts.zoneSlug ? eq(schema.zones.slug, opts.zoneSlug) : undefined,
        opts.poleId ? eq(schema.poles.id, opts.poleId) : undefined,
      ),
    );
  return rows
    .map((r) => toPoleView({ ...r.p, zoneSlug: r.zoneSlug, zoneName: r.zoneName, deviceId: r.deviceId }))
    .sort((a, b) => collator.compare(a.zoneName, b.zoneName) || collator.compare(a.code, b.code));
}

/** Direk satırı + sahibi (bölgeden). Yoksa null — guard 404 döner. */
export async function getPoleWithOwner(
  id: string,
): Promise<{ row: PoleRow; customerId: string } | null> {
  const [r] = await db
    .select({ row: schema.poles, customerId: schema.zones.customerId })
    .from(schema.poles)
    .innerJoin(schema.zones, eq(schema.poles.zoneId, schema.zones.id))
    .where(eq(schema.poles.id, id))
    .limit(1);
  return r ?? null;
}

/** Müşterinin bölgesi (slug → id); başka müşterinin ya da olmayan bölge → undefined. */
export async function resolveCustomerZone(customerId: string, slug: string): Promise<string | undefined> {
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(and(eq(schema.zones.slug, slug), eq(schema.zones.customerId, customerId)))
    .limit(1);
  return zone?.id;
}

/** Numara bu müşteride başka bir direkte kullanılıyor mu? */
export async function poleCodeTaken(customerId: string, code: string, exceptId?: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: schema.poles.id })
    .from(schema.poles)
    .innerJoin(schema.zones, eq(schema.poles.zoneId, schema.zones.id))
    .where(
      and(
        eq(schema.zones.customerId, customerId),
        sql`lower(${schema.poles.code}) = lower(${code})`,
        exceptId ? ne(schema.poles.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return Boolean(hit);
}

export type LinkError = { status: number; technical: string; plain: string };

/**
 * Direğin cihazını ayarlar (`mac` null → bağı kaldırır). Direkteki önceki
 * cihazın bağı kaldırılır. Cihaz müşterinin olmalı, direkle aynı bölgede
 * olmalı ve başka bir direğe bağlı olmamalı.
 */
export async function setPoleDevice(
  tx: Tx,
  pole: { id: string; zoneId: string },
  customerId: string,
  mac: string | null,
): Promise<LinkError | null> {
  if (mac === null) {
    await tx.update(schema.devices).set({ poleId: null }).where(eq(schema.devices.poleId, pole.id));
    return null;
  }
  const norm = normalizeMac(mac);
  const notFound: LinkError = { status: 404, technical: "Cihaz bulunamadı", plain: "Cihaz bulunamadı" };
  if (!norm) return notFound;

  const [dev] = await tx
    .select({
      zoneId: schema.devices.zoneId,
      poleId: schema.devices.poleId,
      customerId: schema.zones.customerId,
    })
    .from(schema.devices)
    .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
    .where(eq(schema.devices.deviceId, norm))
    .limit(1);
  if (!dev || dev.customerId !== customerId) return notFound;
  if (dev.zoneId !== pole.zoneId) {
    return {
      status: 422,
      technical: "Cihaz ile direk aynı bölgede olmalı",
      plain: "Cihaz ile direk aynı bölgede olmalı",
    };
  }
  if (dev.poleId === pole.id) return null;
  if (dev.poleId) {
    const [other] = await tx
      .select({ code: schema.poles.code })
      .from(schema.poles)
      .where(eq(schema.poles.id, dev.poleId))
      .limit(1);
    const text = `Bu cihaz başka bir direğe bağlı${other ? ` (${other.code})` : ""}. Önce oradan kaldırın.`;
    return { status: 409, technical: text, plain: text };
  }

  await tx.update(schema.devices).set({ poleId: null }).where(eq(schema.devices.poleId, pole.id));
  await tx.update(schema.devices).set({ poleId: pole.id }).where(eq(schema.devices.deviceId, norm));
  return null;
}
