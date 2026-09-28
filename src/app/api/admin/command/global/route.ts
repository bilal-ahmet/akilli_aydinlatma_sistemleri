import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/command/global — Meven:all/cmd: TÜM MÜŞTERİLERİN tüm
 * cihazları (acil durum). Yalnızca admin. Tek publish.
 */
export async function POST(req: Request) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }
  const cmd = parsed.data;

  let requestId: string;
  let seq: number;
  try {
    ({ requestId, seq } = publishCommand("all", "all", cmd));
  } catch (err) {
    return fail("Global komut yayınlanamadı", 502, String(err));
  }

  after(async () => {
    await recordCommand("all", "all", requestId, seq, cmd, {
      userId: user.id,
      customerId: null,
    }).catch((err) => console.error("[cmd] global komut kaydı başarısız:", err));
    await audit({ req, user, action: "command.global", target: "all", detail: { ...cmd } });
  });

  return ok({ requestId, seq, status: "pending" }, { status: 202 });
}
