import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { scheduleInputSchema } from "@/types/lighting";
import { authorizeSchedule } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { reloadSchedules } from "@/lib/scheduler";
import {
  checkTargetOwnership,
  rowAsInput,
  scheduleValues,
  toScheduleView,
} from "@/lib/scheduleStore";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

// GET /api/schedules/:id
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await authorizeSchedule(req, id, "read");
  if (ctx instanceof Response) return ctx;
  return ok(toScheduleView(ctx.row));
}

/**
 * PATCH /api/schedules/:id — gelen alanlar mevcut satırla birleştirilip tam
 * şemayla doğrulanır; `next_run_at` yeniden hesaplanır. Yalnızca
 * `{ enabled: false }` gelirse zamanlama durur, `true` ile sonraki zamandan
 * devam eder. Tek seferlik zamanlamanın zamanı geçtiyse açılamaz (422).
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await authorizeSchedule(req, id, "write");
  if (ctx instanceof Response) return ctx;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Geçersiz güncelleme verisi", 422);
  }
  const parsed = scheduleInputSchema.safeParse({ ...rowAsInput(ctx.row), ...body });
  if (!parsed.success) {
    return fail("Geçersiz zamanlama", 422, parsed.error.flatten());
  }
  if ("target" in body) {
    const bad = checkTargetOwnership(parsed.data.target, ctx.customer, await getTenancy());
    if (bad) return fail(bad, 422);
  }

  const values = scheduleValues(parsed.data);
  if (values.enabled && !values.nextRunAt) {
    return fail("Seçilen zaman geçmişte kaldı", 422);
  }

  try {
    const [row] = await db
      .update(schema.schedules)
      .set({ ...values, nextRunAt: values.enabled ? values.nextRunAt : null, updatedAt: sql`now()` })
      .where(eq(schema.schedules.id, id))
      .returning();
    await reloadSchedules();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "schedule.update",
      target: id,
      detail: body as Record<string, unknown>,
    });
    return ok(toScheduleView(row));
  } catch (err) {
    return fail("Zamanlama güncellenemedi", 500, String(err));
  }
}

// DELETE /api/schedules/:id
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  const ctx = await authorizeSchedule(req, id, "write");
  if (ctx instanceof Response) return ctx;

  try {
    await db.delete(schema.schedules).where(eq(schema.schedules.id, id));
    await reloadSchedules();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "schedule.delete",
      target: id,
      detail: { name: ctx.row.name },
    });
    return ok({ deleted: id });
  } catch (err) {
    return fail("Zamanlama silinemedi", 500, String(err));
  }
}
