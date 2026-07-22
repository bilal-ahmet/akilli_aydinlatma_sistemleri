import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toFixture } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { fixtureUpdateSchema } from "@/types/lighting";

export const runtime = "nodejs";

/**
 * PATCH /api/devices/:deviceId/fixtures/:channel — lambanın ismini ve/veya
 * kanalını güncelle.
 *
 * Kanal = cihazın DALI adresi. Değiştirmek yalnızca yanlış girilmiş adresi
 * düzeltmek içindir: eski adresin D4i geçmişi eski kanalda kalır ve cihaz o
 * adresi raporlamayı sürdürürse satır otomatik yeniden oluşur.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ deviceId: string; channel: string }> },
) {
  const { deviceId, channel } = await params;
  const ch = Number(channel);
  if (!Number.isInteger(ch)) return fail("Geçersiz kanal", 422);

  const parsed = fixtureUpdateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz lamba verisi", 422, parsed.error.flatten());
  }
  const { channel: newChannel, name } = parsed.data;

  const patch: { channel?: number; name?: string | null } = {};
  if (name !== undefined) patch.name = name || null;

  if (newChannel !== undefined && newChannel !== ch) {
    const [dup] = await db
      .select({ id: schema.fixtures.id })
      .from(schema.fixtures)
      .where(
        and(
          eq(schema.fixtures.deviceId, deviceId),
          eq(schema.fixtures.channel, newChannel),
        ),
      )
      .limit(1);
    if (dup) return fail("Bu kanal zaten tanımlı", 409);
    patch.channel = newChannel;
  }

  if (Object.keys(patch).length === 0) {
    // Değişen bir şey yok; mevcut satırı olduğu gibi döndür.
    const [row] = await db
      .select()
      .from(schema.fixtures)
      .where(and(eq(schema.fixtures.deviceId, deviceId), eq(schema.fixtures.channel, ch)))
      .limit(1);
    if (!row) return fail("Lamba bulunamadı", 404);
    return ok(toFixture(row));
  }

  try {
    const [row] = await db
      .update(schema.fixtures)
      .set(patch)
      .where(
        and(eq(schema.fixtures.deviceId, deviceId), eq(schema.fixtures.channel, ch)),
      )
      .returning();
    if (!row) return fail("Lamba bulunamadı", 404);
    return ok(toFixture(row));
  } catch (err) {
    return fail("Lamba güncellenemedi", 500, String(err));
  }
}

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
