import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail, msg } from "@/lib/api/respond";
import { authorizeGroup } from "@/lib/auth/guard";
import { getTenancy, refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";
import { normalizeMac } from "@/lib/mac";
import { GROUPS_PER_DEVICE, listZoneGroups } from "@/lib/zoneGroups";
import { kick as kickZoneSync } from "@/lib/zoneSync/engine";
import { zoneGroupMembersSchema } from "@/types/lighting";

export const runtime = "nodejs";

/**
 * POST /api/zones/:zoneId/groups/:groupId/members { add?: MAC[], remove?: MAC[] }
 * Toplu üyelik. Üye yalnızca grubun bölgesindeki cihaz olabilir (422). Her
 * cihaza ayrı `zone_add` / `zone_remove` bölge senkronuyla gider (yalnızca
 * Meven:<MAC>/cmd; çevrimdışı cihaz bağlandığında alır).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ zoneId: string; groupId: string }> },
) {
  const { zoneId, groupId } = await params;
  const ctx = await authorizeGroup(req, zoneId, groupId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = zoneGroupMembersSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Geçersiz üyelik isteği", 422, parsed.error.flatten());

  const idx = await getTenancy();
  // Üye yalnızca grubun bölgesindeki kayıtlı cihaz olabilir.
  const toMacs = (list: string[] | undefined): string[] | string => {
    const out: string[] = [];
    for (const raw of list ?? []) {
      const mac = normalizeMac(raw);
      if (!mac || idx.deviceZone.get(mac) !== zoneId) return raw;
      if (!out.includes(mac)) out.push(mac);
    }
    return out;
  };
  const addList = toMacs(parsed.data.add);
  const removeList = toMacs(parsed.data.remove);
  if (typeof addList === "string" || typeof removeList === "string") {
    const bad = typeof addList === "string" ? addList : removeList;
    return fail(
      msg(ctx.user, `Cihaz bu bölgede değil: ${bad}`, "Seçilen cihazlardan biri bu bölgede değil"),
      422,
    );
  }

  // Firmware sınırı: bölge + en fazla 15 alt grup.
  const current = new Set(idx.groupMacs.get(groupId) ?? []);
  const over = addList.filter(
    (mac) => !current.has(mac) && (idx.deviceGroups.get(mac)?.length ?? 0) >= GROUPS_PER_DEVICE,
  );
  if (over.length > 0) {
    return fail(
      msg(
        ctx.user,
        `Cihaz en fazla ${GROUPS_PER_DEVICE} alt gruba üye olabilir: ${over.join(", ")}`,
        "Bazı cihazlar alt grup sınırına ulaştı",
      ),
      422,
    );
  }

  const [group] = await db
    .select({ id: schema.zoneGroups.id })
    .from(schema.zoneGroups)
    .where(eq(schema.zoneGroups.slug, groupId))
    .limit(1);
  if (!group) return fail("Alt grup bulunamadı", 404);

  const added = addList.filter((mac) => !current.has(mac));
  const removed = removeList.filter((mac) => current.has(mac));
  try {
    await db.transaction(async (tx) => {
      if (added.length > 0) {
        await tx
          .insert(schema.zoneGroupMembers)
          .values(added.map((deviceId) => ({ groupId: group.id, deviceId })))
          .onConflictDoNothing();
      }
      if (removed.length > 0) {
        await tx
          .delete(schema.zoneGroupMembers)
          .where(
            and(
              eq(schema.zoneGroupMembers.groupId, group.id),
              inArray(schema.zoneGroupMembers.deviceId, removed),
            ),
          );
      }
    });
    await refreshTenancy();
    kickZoneSync([...added, ...removed]);
    if (added.length + removed.length > 0) {
      await audit({
        req,
        user: ctx.user,
        customerId: ctx.customer.id,
        action: "zone_group.members",
        target: groupId,
        detail: { added, removed },
      });
    }
    return ok((await listZoneGroups(zoneId)).find((gr) => gr.slug === groupId));
  } catch (err) {
    return fail("Üyelik güncellenemedi", 500, String(err));
  }
}
