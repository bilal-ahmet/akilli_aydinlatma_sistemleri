import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import { getTenancy } from "@/lib/tenancy";
import { zoneSyncView } from "@/lib/zoneSync/engine";
import type { ZoneGroupView } from "@/app/_lib/types";

export const runtime = "nodejs";

// GET /api/groups?customer=<slug> — müşterinin bütün alt grupları (bölge bölge).
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    const rows = await db
      .select({ slug: schema.zoneGroups.slug, name: schema.zoneGroups.name, zoneSlug: schema.zones.slug })
      .from(schema.zoneGroups)
      .innerJoin(schema.zones, eq(schema.zoneGroups.zoneId, schema.zones.id))
      .where(eq(schema.zones.customerId, ctx.customer.id))
      .orderBy(asc(schema.zoneGroups.name));
    const idx = await getTenancy();
    const data: ZoneGroupView[] = rows.map((r) => {
      const members = idx.groupMacs.get(r.slug) ?? [];
      return {
        ...r,
        members: [...members],
        synced: members.filter((mac) => zoneSyncView(mac).status === "synced").length,
      };
    });
    return ok(data);
  } catch (err) {
    return fail("Alt gruplar okunamadı", 500, String(err));
  }
}
