import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { publishCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/devices/:deviceId/command  → cihaz bazlı komut.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const [device] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, deviceId))
    .limit(1);
  if (!device) return fail("Cihaz bulunamadı", 404);

  try {
    const { action, value, number, channel } = parsed.data;
    const { requestId } = await publishCommand("device", deviceId, action, value, number, channel);
    return ok({ requestId, status: "pending" }, { status: 202 });
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }
}
