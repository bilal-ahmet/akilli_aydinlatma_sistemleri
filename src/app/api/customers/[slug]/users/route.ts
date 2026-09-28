import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeCustomerManage } from "@/lib/auth/guard";
import { userCreateSchema } from "@/types/auth";
import { hashPassword } from "@/lib/auth/password";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { toCustomerUser } from "@/lib/adapters";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

// GET /api/customers/:slug/users — müşterinin kullanıcıları (admin veya müşteri kullanıcısı).
export async function GET(req: Request, { params }: Params) {
  const { slug } = await params;
  const ctx = await authorizeCustomerManage(req, slug, "read");
  if (ctx instanceof Response) return ctx;

  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.customerId, ctx.customer.id))
    .orderBy(asc(schema.users.username));
  return ok(rows.map(toCustomerUser));
}

/**
 * POST /api/customers/:slug/users — yeni kullanıcı (admin veya müşteri
 * yöneticisi). İlk girişte şifre değiştirmek zorunludur.
 */
export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const ctx = await authorizeCustomerManage(req, slug, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = userCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Geçersiz kullanıcı verisi", 422);
  }
  const { username, displayName, role, password } = parsed.data;

  const [dup] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  if (dup) return fail("Bu kullanıcı adı alınmış", 409);

  try {
    const [row] = await db
      .insert(schema.users)
      .values({
        username,
        displayName: displayName ?? null,
        role,
        customerId: ctx.customer.id,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
      })
      .returning();
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "user.create",
      target: username,
      detail: { role },
    });
    return ok(toCustomerUser(row), { status: 201 });
  } catch (err) {
    return fail("Kullanıcı oluşturulamadı", 500, String(err));
  }
}
