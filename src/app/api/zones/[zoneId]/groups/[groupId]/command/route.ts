import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";
import { authorizeGroup } from "@/lib/auth/guard";

export const runtime = "nodejs";

/**
 * POST /api/zones/:zoneId/groups/:groupId/command → grubun her üyesinin
 * Meven:<MAC>/cmd'sine ayrı publish, tek komut kaydı (bölge komutuyla aynı
 * kurallar: publish önce, DB sonra; yetki ve üye listesi tenancy'den, DB'siz —
 * Kural #10). `channel` yok sayılır: toplu komuttur. Cihazlar grup topic'ini
 * dinlemediği için senkron durumu komutun ulaşmasını etkilemez.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ zoneId: string; groupId: string }> },
) {
  const { zoneId, groupId } = await params;
  const ctx = await authorizeGroup(req, zoneId, groupId, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  const cmd = { ...parsed.data, channel: undefined };

  let requestId: string;
  let seq: number;
  try {
    ({ requestId, seq } = publishCommand("group", groupId, cmd));
  } catch (err) {
    return fail("Komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("group", groupId, requestId, seq, cmd, {
      userId: ctx.user.id,
      customerId: ctx.customer.id,
    }).catch((err) => console.error("[cmd] alt grup kaydı başarısız:", err)),
  );

  return ok({ requestId, seq, status: "pending" }, { status: 202 });
}
