import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { deviceCreateSchema } from "@/types/lighting";

export const runtime = "nodejs";

const selectShape = {
  id: schema.devices.id,
  deviceId: schema.devices.deviceId,
  name: schema.devices.name,
  lastSeen: schema.devices.lastSeen,
  zoneSlug: schema.zones.slug,
  zoneName: schema.zones.name,
};

// GET /api/devices — tüm cihazlar (bağlı zone bilgisiyle).
export async function GET() {
  try {
    const rows = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .orderBy(asc(schema.devices.deviceId));
    return ok(rows.map(toDeviceView));
  } catch (err) {
    return fail("Cihazlar okunamadı", 500, String(err));
  }
}

// POST /api/devices — yeni cihaz kaydı (deviceId + zone).
export async function POST(req: Request) {
  const parsed = deviceCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz cihaz verisi", 422, parsed.error.flatten());
  }
  const { deviceId, zoneSlug, name } = parsed.data;

  // Zone var mı?
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneSlug))
    .limit(1);
  if (!zone) return fail("Zone bulunamadı", 404);

  // deviceId benzersiz mi?
  const [dup] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, deviceId))
    .limit(1);
  if (dup) return fail("Bu cihaz kimliği zaten kayıtlı", 409);

  try {
    await db.insert(schema.devices).values({
      deviceId,
      zoneId: zone.id,
      name: name ?? null,
    });

    const [row] = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(eq(schema.devices.deviceId, deviceId))
      .limit(1);
    return ok(toDeviceView(row), { status: 201 });
  } catch (err) {
    return fail("Cihaz oluşturulamadı", 500, String(err));
  }
}
