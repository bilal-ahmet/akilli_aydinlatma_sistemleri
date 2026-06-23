import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { slugify } from "@/lib/slug";
import { zoneCreateSchema } from "@/types/lighting";

export const runtime = "nodejs";

// GET /api/zones — tüm zone'lar (dashboard snapshot'ı DB'den).
export async function GET() {
  try {
    const rows = await db
      .select()
      .from(schema.zones)
      .orderBy(asc(schema.zones.name));
    return ok(rows.map(toZone));
  } catch (err) {
    return fail("Zone'lar okunamadı", 500, String(err));
  }
}

// POST /api/zones — yeni zone oluştur.
export async function POST(req: Request) {
  const parsed = zoneCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz zone verisi", 422, parsed.error.flatten());
  }
  const { name, district, poleCount, status } = parsed.data;

  // Benzersiz slug üret (isimden; çakışırsa sayı ekle).
  const base = parsed.data.slug ? slugify(parsed.data.slug) : slugify(name);
  if (!base) return fail("Geçerli bir slug üretilemedi", 422);

  let slug = base;
  for (let i = 2; ; i++) {
    const [exists] = await db
      .select({ id: schema.zones.id })
      .from(schema.zones)
      .where(eq(schema.zones.slug, slug))
      .limit(1);
    if (!exists) break;
    slug = `${base}-${i}`;
  }

  try {
    const [row] = await db
      .insert(schema.zones)
      .values({
        slug,
        name,
        district: district ?? null,
        poleCount: poleCount ?? 0,
        status: status ?? "ok",
        isOn: false,
        brightness: 0,
      })
      .returning();
    return ok(toZone(row), { status: 201 });
  } catch (err) {
    return fail("Zone oluşturulamadı", 500, String(err));
  }
}
