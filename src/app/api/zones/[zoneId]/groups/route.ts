import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeZone } from "@/lib/auth/guard";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { allocateGroupSlug } from "@/lib/zoneSlug";
import { listZoneGroups } from "@/lib/zoneGroups";
import { zoneGroupCreateSchema } from "@/types/lighting";

export const runtime = "nodejs";

// GET /api/zones/:zoneId/groups — bölgenin alt grupları (üyeler + senkron özeti).
export async function GET(req: Request, { params }: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params;
  const ctx = await authorizeZone(req, zoneId, "read");
  if (ctx instanceof Response) return ctx;
  try {
    return ok(await listZoneGroups(zoneId));
  } catch (err) {
    return fail("Alt gruplar okunamadı", 500, String(err));
  }
}

/**
 * POST /api/zones/:zoneId/groups { name } — alt grup oluştur. Slug adla bölge
 * slug'ından üretilir (`ekaldes-hat-a`, ≤32, global benzersiz, emekli slug'lar
 * yeniden verilmez) ve değişmez: cihazlar o topic'i NVS'te tutar.
 */
export async function POST(req: Request, { params }: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params;
  const ctx = await authorizeZone(req, zoneId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = zoneGroupCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Geçersiz alt grup", 422, parsed.error.flatten());

  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneId))
    .limit(1);
  if (!zone) return fail("Bölge bulunamadı", 404);

  const slug = await allocateGroupSlug(zoneId, parsed.data.name);
  if (!slug) return fail("Bu addan alt grup kimliği üretilemedi", 422);

  try {
    await db.insert(schema.zoneGroups).values({ zoneId: zone.id, slug, name: parsed.data.name });
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone_group.create",
      target: slug,
      detail: { zone: zoneId, name: parsed.data.name },
    });
    const created = (await listZoneGroups(zoneId)).find((gr) => gr.slug === slug);
    return ok(created, { status: 201 });
  } catch (err) {
    return fail("Alt grup oluşturulamadı", 500, String(err));
  }
}
