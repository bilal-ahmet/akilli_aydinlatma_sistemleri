import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeCustomerManage } from "@/lib/auth/guard";
import { userUpdateSchema } from "@/types/auth";
import { hashPassword } from "@/lib/auth/password";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { toCustomerUser } from "@/lib/adapters";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string; userId: string }> };

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function findUser(customerId: string, userId: string) {
  if (!UUID_RE.test(userId)) return undefined;
  const [row] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.customerId, customerId)))
    .limit(1);
  return row;
}

/**
 * PATCH /api/customers/:slug/users/:userId — isim, rol, aktiflik, şifre sıfırlama.
 * Şifre sıfırlanınca kullanıcı ilk girişte değiştirmek zorundadır ve açık
 * oturumları düşer. Müşteri yöneticisi KENDİ rolünü/aktifliğini değiştiremez
 * (panelde kilitli kalmasın).
 */
export async function PATCH(req: Request, { params }: Params) {
  const { slug, userId } = await params;
  const ctx = await authorizeCustomerManage(req, slug, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = userUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Geçersiz veri", 422);
  }
  const target = await findUser(ctx.customer.id, userId);
  if (!target) return fail("Kullanıcı bulunamadı", 404);

  const d = parsed.data;
  const self = target.id === ctx.user.id;
  if (self && (d.role !== undefined || d.isActive !== undefined)) {
    return fail("Kendi rolünüzü veya aktifliğinizi değiştiremezsiniz", 422);
  }

  const patch: Partial<typeof schema.users.$inferInsert> & { tokenVersion?: unknown } = {};
  if (d.displayName !== undefined) patch.displayName = d.displayName || null;
  if (d.role !== undefined) patch.role = d.role;
  if (d.isActive !== undefined) patch.isActive = d.isActive;
  if (d.password !== undefined) {
    patch.passwordHash = await hashPassword(d.password);
    patch.mustChangePassword = true;
  }

  const [row] = await db
    .update(schema.users)
    .set({
      ...patch,
      ...(d.password !== undefined
        ? { tokenVersion: sql`${schema.users.tokenVersion} + 1` }
        : {}),
    })
    .where(eq(schema.users.id, target.id))
    .returning();

  await refreshTenancy();
  const { password: _pw, ...logged } = d;
  void _pw;
  await audit({
    req,
    user: ctx.user,
    customerId: ctx.customer.id,
    action: d.password !== undefined ? "user.password_reset" : "user.update",
    target: target.username,
    detail: logged,
  });
  return ok(toCustomerUser(row));
}

// DELETE /api/customers/:slug/users/:userId — kullanıcıyı sil (kendini silemez).
export async function DELETE(req: Request, { params }: Params) {
  const { slug, userId } = await params;
  const ctx = await authorizeCustomerManage(req, slug, "write");
  if (ctx instanceof Response) return ctx;

  const target = await findUser(ctx.customer.id, userId);
  if (!target) return fail("Kullanıcı bulunamadı", 404);
  if (target.id === ctx.user.id) return fail("Kendi hesabınızı silemezsiniz", 422);

  await db.delete(schema.users).where(eq(schema.users.id, target.id));
  await refreshTenancy();
  await audit({
    req,
    user: ctx.user,
    customerId: ctx.customer.id,
    action: "user.delete",
    target: target.username,
  });
  return ok({ deleted: target.id });
}
