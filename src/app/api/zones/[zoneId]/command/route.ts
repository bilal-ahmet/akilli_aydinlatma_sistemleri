import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { publishCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/zones/:zoneId/command  → tek MQTT publish, zone'daki tüm cihazlar alır.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  // Zone gerçekten var mı?
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneId))
    .limit(1);
  if (!zone) return fail("Zone bulunamadı", 404);

  try {
    const { action, value, number } = parsed.data;
    const { requestId } = await publishCommand("zone", zoneId, action, value, number);
    return ok({ requestId, status: "pending" }, { status: 202 });
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }
}
