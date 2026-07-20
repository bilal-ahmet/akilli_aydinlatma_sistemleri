import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/command/all — toplu komut: Meven:all/cmd'ye tek publish.
// Publish önce, DB sonra (bkz. lib/mqtt.ts).
export async function POST(req: Request) {
  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const { action, value, number } = parsed.data;

  let requestId: string;
  let seq: number;
  try {
    // MQTT client kurulamazsa (örn. env eksik) burada fırlar → 502.
    ({ requestId, seq } = publishCommand("all", "all", action, value, number));
  } catch (err) {
    return fail("Toplu komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("all", "all", requestId, seq, action, value, number).catch((err) =>
      console.error("[cmd] toplu komut kaydı başarısız:", err),
    ),
  );

  return ok({ requestId, seq, status: "pending" }, { status: 202 });
}
