import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/devices/:deviceId/command  → Meven:<MAC>/cmd'ye tek publish.
// channel verilirse tek lamba, yoksa tüm cihaz. Publish önce, DB sonra (bkz. lib/mqtt.ts).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId } = await params;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const { action, value, number, channel } = parsed.data;

  let requestId: string;
  let seq: number;
  try {
    // MQTT client kurulamazsa (örn. env eksik) burada fırlar → 502.
    ({ requestId, seq } = publishCommand("device", deviceId, action, value, number, channel));
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("device", deviceId, requestId, seq, action, value, number, channel).catch((err) =>
      console.error("[cmd] cihaz kaydı başarısız:", err),
    ),
  );

  return ok({ requestId, seq, status: "pending" }, { status: 202 });
}
