import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { customerCreateSchema } from "@/types/auth";
import { allocateCustomerSlug } from "@/lib/zoneSlug";
import { listCustomerOverviews } from "@/lib/customers";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

// GET /api/admin/customers — tüm müşteriler, sayılar ve ölçülmüş özetle.
export async function GET(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  try {
    return ok(await listCustomerOverviews());
  } catch (err) {
    return fail("Müşteriler okunamadı", 500, String(err));
  }
}

// POST /api/admin/customers — yeni müşteri.
export async function POST(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;

  const parsed = customerCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Geçersiz müşteri verisi", 422);
  }
  const { name, slug: wanted, ...contact } = parsed.data;
  const slug = await allocateCustomerSlug(wanted || name);
  if (!slug) return fail("Geçerli bir kısa ad (slug) üretilemedi", 422);

  try {
    const [row] = await db
      .insert(schema.customers)
      .values({ slug, name, ...contact })
      .returning();
    await refreshTenancy();
    await audit({ req, user, customerId: row.id, action: "customer.create", target: slug, detail: { name } });
    return ok({ id: row.id, slug: row.slug, name: row.name }, { status: 201 });
  } catch (err) {
    return fail("Müşteri oluşturulamadı", 500, String(err));
  }
}
