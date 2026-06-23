import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toZone } from "@/lib/adapters";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// GET /api/zones — tüm zone'lar (dashboard snapshot'ı DB'den).
export async function GET() {
  try {
    const rows = await db
      .select()
      .from(schema.zones)
      .orderBy(asc(schema.zones.name));
    return ok(rows.map(toZone));
  } catch (err) {
    return fail("Zone'lar okunamadı", 500, String(err));
  }
}
