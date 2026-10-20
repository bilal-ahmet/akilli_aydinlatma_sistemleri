import { count, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { scheduleInputSchema } from "@/types/lighting";
import { authorizeScope } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { reloadSchedules } from "@/lib/scheduler";
import { SCHEDULE_LIMIT } from "@/lib/scheduleTime";
import {
  checkTargetOwnership,
  listSchedules,
  scheduleValues,
  toScheduleView,
} from "@/lib/scheduleStore";

export const runtime = "nodejs";

// GET /api/schedules?customer=<slug> — müşterinin zamanlamaları.
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    return ok(await listSchedules(ctx.customer.id));
  } catch (err) {
    return fail("Zamanlamalar okunamadı", 500, String(err));
  }
}

/**
 * POST /api/schedules?customer=<slug> — yeni zamanlama. Hedef istemcideki
 * `planTargets` çıktısıdır; bölge/MAC'ler müşteriye ait olmalı. Yanıt
 * dönmeden zamanlayıcı yeniden yüklenir (Kural #15 deseni).
 */
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = scheduleInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz zamanlama", 422, parsed.error.flatten());
  }
  const bad = checkTargetOwnership(parsed.data.target, ctx.customer, await getTenancy());
  if (bad) return fail(bad, 422);

  const values = scheduleValues(parsed.data);
  if (!values.nextRunAt) return fail("Seçilen zaman geçmişte kaldı", 422);

  try {
    const [{ n }] = await db
      .select({ n: count() })
      .from(schema.schedules)
      .where(eq(schema.schedules.customerId, ctx.customer.id));
    if (n >= SCHEDULE_LIMIT) {
      return fail(`En fazla ${SCHEDULE_LIMIT} zamanlama oluşturulabilir`, 409);
    }

    const [row] = await db
      .insert(schema.schedules)
      .values({ ...values, customerId: ctx.customer.id, createdBy: ctx.user.id })
      .returning();
    await reloadSchedules();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "schedule.create",
      target: row.id,
      detail: { name: row.name, action: row.action, repeat: row.repeat, timeKind: row.timeKind },
    });
    return ok(toScheduleView(row), { status: 201 });
  } catch (err) {
    return fail("Zamanlama oluşturulamadı", 500, String(err));
  }
}
