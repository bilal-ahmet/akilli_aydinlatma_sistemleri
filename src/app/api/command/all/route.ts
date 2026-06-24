import { publishCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";

export const runtime = "nodejs";

// POST /api/command/all — toplu komut: Meven:all/cmd'ye tek publish.
export async function POST(req: Request) {
  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }
  try {
    const { action, value } = parsed.data;
    const { requestId } = await publishCommand("all", "all", action, value);
    return ok({ requestId, status: "pending" }, { status: 202 });
  } catch (err) {
    return fail("Toplu komut yayınlanamadı", 502, String(err));
  }
}
