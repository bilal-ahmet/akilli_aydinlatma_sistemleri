import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { customerUpdateSchema } from "@/types/auth";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import type { AuditEntry } from "@/types/admin";

export const runtime = "nodejs";

type Params = { params: Promise<{ slug: string }> };

async function findCustomer(slug: string) {
  const [row] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.slug, slug))
    .limit(1);
  return row;
}

// GET /api/admin/customers/:slug — müşteri bilgileri + son 50 denetim kaydı.
export async function GET(req: Request, { params }: Params) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  const { slug } = await params;
  const row = await findCustomer(slug);
  if (!row) return fail("Müşteri bulunamadı", 404);

  const logs = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.customerId, row.id))
    .orderBy(desc(schema.auditLog.at))
    .limit(50);

  const auditEntries: AuditEntry[] = logs.map((l) => ({
    id: l.id,
    at: l.at.toISOString(),
    username: l.username,
    action: l.action,
    target: l.target,
    detail: l.detail,
    ip: l.ip,
  }));

  return ok({
    customer: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      contactPhone: row.contactPhone,
      notes: row.notes,
      isActive: row.isActive,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    },
    audit: auditEntries,
  });
}

/**
 * PATCH /api/admin/customers/:slug — bilgiler ve aktiflik. Pasif müşterinin
 * kullanıcıları giriş yapamaz, açık oturumları bir sonraki istekte düşer;
 * cihazları çalışmaya devam eder.
 */
export async function PATCH(req: Request, { params }: Params) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  const { slug } = await params;

  const parsed = customerUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Geçersiz veri", 422);
  }
  const d = parsed.data;
  const patch: Partial<typeof schema.customers.$inferInsert> = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.contactName !== undefined) patch.contactName = d.contactName || null;
  if (d.contactEmail !== undefined) patch.contactEmail = d.contactEmail || null;
  if (d.contactPhone !== undefined) patch.contactPhone = d.contactPhone || null;
  if (d.notes !== undefined) patch.notes = d.notes || null;
  if (d.isActive !== undefined) patch.isActive = d.isActive;

  const [row] = await db
    .update(schema.customers)
    .set(patch)
    .where(eq(schema.customers.slug, slug))
    .returning();
  if (!row) return fail("Müşteri bulunamadı", 404);

  await refreshTenancy();
  await audit({ req, user, customerId: row.id, action: "customer.update", target: slug, detail: d });
  return ok({ id: row.id, slug: row.slug, name: row.name, isActive: row.isActive });
}

/**
 * DELETE /api/admin/customers/:slug — yalnızca bölgesi olmayan müşteri
 * silinir (kullanıcılarıyla birlikte). Bölgeleri olan müşteri önce
 * pasifleştirilmeli ya da bölgeleri taşınmalı/silinmeli.
 */
export async function DELETE(req: Request, { params }: Params) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;
  const { slug } = await params;

  const info = (await getTenancy()).customersBySlug.get(slug);
  if (!info) return fail("Müşteri bulunamadı", 404);
  if (info.zoneSlugs.length > 0) {
    return fail(
      `Müşterinin ${info.zoneSlugs.length} bölgesi var. Önce bölgeleri taşıyın ya da silin; ya da müşteriyi pasifleştirin.`,
      409,
    );
  }

  try {
    await db.transaction(async (tx) => {
      await tx.delete(schema.users).where(eq(schema.users.customerId, info.id));
      await tx.delete(schema.customers).where(eq(schema.customers.id, info.id));
    });
    await refreshTenancy();
    await audit({ req, user, customerId: info.id, action: "customer.delete", target: slug });
    return ok({ deleted: slug });
  } catch (err) {
    return fail("Müşteri silinemedi", 500, String(err));
  }
}
