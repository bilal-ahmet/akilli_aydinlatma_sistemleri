import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";
import { deviceCreateSchema } from "@/types/lighting";
import { normalizeMac } from "@/lib/mac";

export const runtime = "nodejs";

const selectShape = {
  id: schema.devices.id,
  deviceId: schema.devices.deviceId,
  name: schema.devices.name,
  lastSeen: schema.devices.lastSeen,
  lastError: schema.devices.lastError,
  lastErrorAt: schema.devices.lastErrorAt,
  zoneSlug: schema.zones.slug,
  zoneName: schema.zones.name,
};

// GET /api/devices — tüm cihazlar (bölge + son telemetri ile).
export async function GET() {
  try {
    const rows = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .orderBy(asc(schema.devices.deviceId));

    // Her cihaz için en güncel device_status'u getir (recordedAt desc, ilk satır).
    const ids = rows.map((r) => r.deviceId);
    const latest = new Map<
      string,
      { brightness: number | null; relayStatus: string | null; temperature: number | null; rssi: number | null }
    >();
    if (ids.length > 0) {
      const statuses = await db
        .select({
          deviceId: schema.deviceStatus.deviceId,
          brightness: schema.deviceStatus.brightness,
          relayStatus: schema.deviceStatus.relayStatus,
          temperature: schema.deviceStatus.temperature,
          rssi: schema.deviceStatus.rssi,
        })
        .from(schema.deviceStatus)
        .where(inArray(schema.deviceStatus.deviceId, ids))
        .orderBy(desc(schema.deviceStatus.recordedAt));
      for (const s of statuses) {
        if (!latest.has(s.deviceId)) latest.set(s.deviceId, s);
      }
    }

    return ok(rows.map((r) => toDeviceView({ ...r, ...latest.get(r.deviceId) })));
  } catch (err) {
    return fail("Cihazlar okunamadı", 500, String(err));
  }
}

// POST /api/devices — yeni cihaz kaydı (MAC + bölge).
export async function POST(req: Request) {
  const parsed = deviceCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz cihaz verisi", 422, parsed.error.flatten());
  }

  const mac = normalizeMac(parsed.data.mac);
  if (!mac) return fail("Geçersiz MAC adresi (12 hane hex bekleniyor)", 422);
  const { zoneSlug, name } = parsed.data;

  // Bölge var mı?
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(eq(schema.zones.slug, zoneSlug))
    .limit(1);
  if (!zone) return fail("Bölge bulunamadı", 404);

  // MAC benzersiz mi?
  const [dup] = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, mac))
    .limit(1);
  if (dup) return fail("Bu MAC adresi zaten kayıtlı", 409);

  try {
    await db.insert(schema.devices).values({
      deviceId: mac,
      zoneId: zone.id,
      name: name ?? null,
    });

    const [row] = await db
      .select(selectShape)
      .from(schema.devices)
      .leftJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(eq(schema.devices.deviceId, mac))
      .limit(1);
    return ok(toDeviceView(row), { status: 201 });
  } catch (err) {
    return fail("Cihaz oluşturulamadı", 500, String(err));
  }
}
