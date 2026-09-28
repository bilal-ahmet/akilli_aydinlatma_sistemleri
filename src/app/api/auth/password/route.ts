import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { passwordChangeSchema } from "@/types/auth";
import { authorizeUser } from "@/lib/auth/guard";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { writeSessionCookie } from "@/lib/auth/session";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/auth/password — kendi şifresini değiştirir. Token sürümü artar:
 * diğer tüm oturumlar düşer, bu oturum yeni çerezle devam eder.
 */
export async function POST(req: Request) {
  const user = await authorizeUser(req, { allowMustChange: true });
  if (user instanceof Response) return user;

  const parsed = passwordChangeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Geçersiz veri", 422);
  }
  const { currentPassword, newPassword } = parsed.data;
  if (currentPassword === newPassword) return fail("Yeni şifre eskisiyle aynı olamaz", 422);

  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return fail("Mevcut şifre hatalı", 401);
  }

  const [updated] = await db
    .update(schema.users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      tokenVersion: sql`${schema.users.tokenVersion} + 1`,
    })
    .where(eq(schema.users.id, user.id))
    .returning({ tokenVersion: schema.users.tokenVersion });

  await refreshTenancy();
  await writeSessionCookie({
    id: user.id,
    role: user.role,
    customerId: user.customerId,
    tokenVersion: updated.tokenVersion,
  });
  await audit({ req, user, action: "auth.password_change", customerId: user.customerId });

  return ok({ redirect: "/" });
}
