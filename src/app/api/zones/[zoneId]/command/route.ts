import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/zones/:zoneId/command  → Meven:<slug>/cmd'ye tek publish.
// Publish önce, DB sonra: komut hiçbir sorguyu beklemez (bkz. lib/mqtt.ts).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ zoneId: string }> },
) {
  const { zoneId } = await params;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const { action, value, number } = parsed.data;

  let requestId: string;
  try {
    // MQTT client kurulamazsa (örn. env eksik) burada fırlar → 502.
    ({ requestId } = publishCommand("zone", zoneId, action, value, number));
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("zone", zoneId, requestId, action, value, number).catch((err) =>
      console.error("[cmd] zone kaydı başarısız:", err),
    ),
  );

  return ok({ requestId, status: "pending" }, { status: 202 });
}
