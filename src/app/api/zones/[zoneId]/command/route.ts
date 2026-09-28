import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";
import { authorizeZone } from "@/lib/auth/guard";

export const runtime = "nodejs";

// POST /api/zones/:zoneId/command  → Meven:<slug>/cmd'ye tek publish.
// Publish önce, DB sonra: komut hiçbir sorguyu beklemez (bkz. lib/mqtt.ts).
// Yetki kontrolü tenancy index'inden okunur, DB'ye gitmez (Kural #10).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;
  const ctx = await authorizeZone(req, zoneId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const cmd = parsed.data;

  let requestId: string;
  let seq: number;
  try {
    // MQTT client kurulamazsa (örn. env eksik) burada fırlar → 502.
    ({ requestId, seq } = publishCommand("zone", zoneId, cmd));
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("zone", zoneId, requestId, seq, cmd, {
      userId: ctx.user.id,
      customerId: ctx.customer.id,
    }).catch((err) => console.error("[cmd] zone kaydı başarısız:", err)),
  );

  return ok({ requestId, seq, status: "pending" }, { status: 202 });
}
