import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toDeviceView } from "@/lib/adapters";
import { ok, fail, msg } from "@/lib/api/respond";
import { deviceCreateSchema } from "@/types/lighting";
import { normalizeMac } from "@/lib/mac";
import { authorizeScope } from "@/lib/auth/guard";
import { refreshTenancy } from "@/lib/tenancy";
import { audit } from "@/lib/audit";

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

// GET /api/devices?customer=<slug> — müşterinin cihazları (bölge + son telemetri ile).
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;
  try {
    const rows = await db
      .select(selectShape)
      .from(schema.devices)
      .innerJoin(schema.zones, eq(schema.devices.zoneId, schema.zones.id))
      .where(eq(schema.zones.customerId, ctx.customer.id))
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

    // Lamba sayısı + çalışan efekt (Efektler sayfasındaki cihaz seçimi için).
    const lamps = new Map<string, { lampCount: number; activeFx: number | null }>();
    if (ids.length > 0) {
      const fixtures = await db
        .select({ deviceId: schema.fixtures.deviceId, activeFx: schema.fixtures.activeFx })
        .from(schema.fixtures)
        .where(inArray(schema.fixtures.deviceId, ids))
        .orderBy(asc(schema.fixtures.channel));
      for (const f of fixtures) {
        const cur = lamps.get(f.deviceId) ?? { lampCount: 0, activeFx: null };
        cur.lampCount += 1;
        cur.activeFx ??= f.activeFx;
        lamps.set(f.deviceId, cur);
      }
    }

    return ok(
      rows.map((r) =>
        toDeviceView({ ...r, ...latest.get(r.deviceId), ...lamps.get(r.deviceId) }),
      ),
    );
  } catch (err) {
    return fail("Cihazlar okunamadı", 500, String(err));
  }
}

// POST /api/devices?customer=<slug> — yeni cihaz kaydı (MAC + müşterinin bölgesi).
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = deviceCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz cihaz verisi", 422, parsed.error.flatten());
  }

  const mac = normalizeMac(parsed.data.mac);
  if (!mac) {
    return fail(
      msg(
        ctx.user,
        "Geçersiz MAC adresi (12 hane hex bekleniyor)",
        "Geçersiz cihaz kodu: 12 karakter olmalı (rakamlar ve A-F harfleri)",
      ),
      422,
    );
  }
  const { zoneSlug, name } = parsed.data;

  // Bölge bu müşterinin mi?
  const [zone] = await db
    .select({ id: schema.zones.id })
    .from(schema.zones)
    .where(and(eq(schema.zones.slug, zoneSlug), eq(schema.zones.customerId, ctx.customer.id)))
    .limit(1);
  if (!zone) return fail("Bölge bulunamadı", 404);

  // MAC benzersiz mi? Başka müşterideyse sahibi AÇIKLANMAZ.
  const [dup] = await db
    .select({ id: schema.devices.id, zoneId: schema.devices.zoneId })
    .from(schema.devices)
    .where(eq(schema.devices.deviceId, mac))
    .limit(1);
  if (dup) {
    const [dupZone] = dup.zoneId
      ? await db
          .select({ customerId: schema.zones.customerId })
          .from(schema.zones)
          .where(eq(schema.zones.id, dup.zoneId))
          .limit(1)
      : [];
    if (dupZone?.customerId === ctx.customer.id) {
      return fail(msg(ctx.user, "Bu MAC adresi zaten kayıtlı", "Bu cihaz kodu zaten kayıtlı"), 409);
    }
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "device.create_conflict",
      target: mac,
    });
    return fail(
      msg(
        ctx.user,
        "Bu MAC adresi başka bir hesapta kayıtlı. Yöneticinize başvurun.",
        "Bu cihaz kodu başka bir hesapta kayıtlı. Yöneticinize başvurun.",
      ),
      409,
    );
  }

  try {
    await db.insert(schema.devices).values({
      deviceId: mac,
      zoneId: zone.id,
      name: name ?? null,
    });
    await refreshTenancy();
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "device.create",
      target: mac,
      detail: { zoneSlug, name: name ?? null },
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
