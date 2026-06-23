import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// GET /api/devices — tüm cihaz listesi.
export async function GET() {
  try {
    const rows = await db
      .select()
      .from(schema.devices)
      .orderBy(asc(schema.devices.deviceId));
    return ok(rows);
  } catch (err) {
    return fail("Cihazlar okunamadı", 500, String(err));
  }
}
