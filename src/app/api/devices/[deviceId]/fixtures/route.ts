import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toFixture } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { fixtureCreateSchema } from "@/types/lighting";

export const runtime = "nodejs";

// GET /api/devices/:deviceId/fixtures → cihaza bağlı lambalar (kanal sırasıyla).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;
  try {
    const rows = await db
      .select()
      .from(schema.fixtures)
      .where(eq(schema.fixtures.deviceId, deviceId))
      .orderBy(asc(schema.fixtures.channel));
    return ok(rows.map(toFixture));
  } catch (err) {
    return fail("Lambalar okunamadı", 500, String(err));
  }
}

// POST /api/devices/:deviceId/fixtures → manuel lamba (kanal) ekle.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  const parsed = fixtureCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz lamba verisi", 422, parsed.error.flatten());
  }

  // Cihaz kayıtlı mı?
  const [device] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, deviceId))
    .limit(1);
  if (!device) return fail("Cihaz bulunamadı", 404);

  const { channel, name } = parsed.data;

  // Aynı kanal zaten var mı?
  const [dup] = await db
    .select({ id: schema.fixtures.id })
    .from(schema.fixtures)
    .where(
      and(
        eq(schema.fixtures.deviceId, deviceId),
        eq(schema.fixtures.channel, channel),
      ),
    )
    .limit(1);
  if (dup) return fail("Bu kanal zaten tanımlı", 409);

  try {
    const [row] = await db
      .insert(schema.fixtures)
      .values({ deviceId, channel, name: name ?? null })
      .returning();
    return ok(toFixture(row), { status: 201 });
  } catch (err) {
    return fail("Lamba oluşturulamadı", 500, String(err));
  }
}
