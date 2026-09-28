import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { isReservedZoneSlug, slugify } from "@/lib/slug";
import { allocateZoneSlug } from "@/lib/zoneSlug";
import { zoneCreateSchema } from "@/types/lighting";
import { authorizeScope } from "@/lib/auth/guard";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

// GET /api/zones?customer=<slug> — müşterinin bölgeleri (dashboard snapshot'ı DB'den).
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    const rows = await db
      .select()
      .from(schema.zones)
      .where(eq(schema.zones.customerId, ctx.customer.id))
      .orderBy(asc(schema.zones.name));
    return ok(rows.map(toZone));
  } catch (err) {
    return fail("Zone'lar okunamadı", 500, String(err));
  }
}

// POST /api/zones?customer=<slug> — müşteriye yeni bölge.
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = zoneCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz zone verisi", 422, parsed.error.flatten());
  }
  const { name, district, poleCount, status } = parsed.data;

  // Açıkça istenen slug rezerv ise reddet (örn. "all" → Meven:all/cmd tüm
  // müşterilerin cihazlarını sürerdi). İsimden türetilende ise önek eklenir.
  if (parsed.data.slug) {
    const wanted = slugify(parsed.data.slug);
    if (!wanted) return fail("Geçerli bir slug üretilemedi", 422);
    if (isReservedZoneSlug(wanted)) {
      return fail(`"${wanted}" sistem tarafından ayrılmış, başka bir kısa ad seçin`, 422);
    }
  }

  const slug = await allocateZoneSlug(parsed.data.slug || name);
  if (!slug) return fail("Geçerli bir slug üretilemedi", 422);

  try {
    const [row] = await db
      .insert(schema.zones)
      .values({
        slug,
        customerId: ctx.customer.id,
        name,
        district: district ?? null,
        poleCount: poleCount ?? 0,
        status: status ?? "ok",
        isOn: false,
        brightness: 0,
      })
      .returning();
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone.create",
      target: slug,
      detail: { name },
    });
    return ok(toZone(row), { status: 201 });
  } catch (err) {
    return fail("Zone oluşturulamadı", 500, String(err));
  }
}
