import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeGroup } from "@/lib/auth/guard";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { listZoneGroups } from "@/lib/zoneGroups";
import { kick as kickZoneSync } from "@/lib/zoneSync/engine";
import { zoneGroupUpdateSchema } from "@/types/lighting";

export const runtime = "nodejs";

type Params = { params: Promise<{ zoneId: string; groupId: string }> };

// PATCH /api/zones/:zoneId/groups/:groupId { name } — yalnızca ad; slug değişmez.
export async function PATCH(req: Request, { params }: Params) {
  const { zoneId, groupId } = await params;
  const ctx = await authorizeGroup(req, zoneId, groupId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = zoneGroupUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Geçersiz alt grup", 422, parsed.error.flatten());

  try {
    const [row] = await db
      .update(schema.zoneGroups)
      .set({ name: parsed.data.name })
      .where(eq(schema.zoneGroups.slug, groupId))
      .returning({ slug: schema.zoneGroups.slug });
    if (!row) return fail("Alt grup bulunamadı", 404);
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone_group.update",
      target: groupId,
      detail: parsed.data,
    });
    return ok((await listZoneGroups(zoneId)).find((gr) => gr.slug === groupId));
  } catch (err) {
    return fail("Alt grup güncellenemedi", 500, String(err));
  }
}

/**
 * DELETE /api/zones/:zoneId/groups/:groupId — grubu sil. Slug emekliye ayrılır
 * (bir daha verilmez) ve üyelere bölge senkronuyla `zone_remove` gider;
 * çevrimdışı üyeler bağlandığında alır. Yalnızca DB'den silmek yetmezdi:
 * cihazlar topic'i NVS'te tutup dinlemeye devam ederdi.
 */
export async function DELETE(req: Request, { params }: Params) {
  const { zoneId, groupId } = await params;
  const ctx = await authorizeGroup(req, zoneId, groupId, "write");
  if (ctx instanceof Response) return ctx;

  const members = [...((await getTenancy()).groupMacs.get(groupId) ?? [])];
  try {
    await db.transaction(async (tx) => {
      await tx.delete(schema.zoneGroups).where(eq(schema.zoneGroups.slug, groupId));
      await tx
        .insert(schema.retiredZoneSlugs)
        .values({ slug: groupId, customerId: ctx.customer.id })
        .onConflictDoNothing();
    });
    await refreshTenancy();
    kickZoneSync(members);
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "zone_group.delete",
      target: groupId,
      detail: { zone: zoneId, members: members.length },
    });
    return ok({ deleted: groupId });
  } catch (err) {
    return fail("Alt grup silinemedi", 500, String(err));
  }
}
