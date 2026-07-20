import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// DELETE /api/devices/:deviceId/fixtures/:channel → lamba (kanal) kaydını sil.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string; channel: string }> },
) {
  const { deviceId, channel } = await params;
  const ch = Number(channel);
  if (!Number.isInteger(ch)) return fail("Geçersiz kanal", 422);

  try {
    const deleted = await db
      .delete(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.deviceId, deviceId),
          eq(schema.fixtures.channel, ch),
        ),
      )
      .returning({ id: schema.fixtures.id });
    if (deleted.length === 0) return fail("Lamba bulunamadı", 404);
    return ok({ deleted: true });
  } catch (err) {
    return fail("Lamba silinemedi", 500, String(err));
  }
}
