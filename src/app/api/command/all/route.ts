import { after } from "next/server";
import { publishCommand, recordCommand } from "@/lib/mqtt";
import { commandRequestSchema } from "@/types/lighting";
import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";

export const runtime = "nodejs";

/**
 * POST /api/command/all?customer=<slug> — MÜŞTERİNİN "Tüm Sistem"i.
 *
 * Artık Meven:all/cmd'ye GİTMEZ (o topic'e tüm müşterilerin cihazları abone):
 * müşterinin her bölgesinin topic'ine ayrı publish yapılır (bkz.
 * publishCommand "customer"). Bölge listesi tenancy index'inden gelir, DB
 * beklenmez. Tüm müşterileri kapsayan global komut: /api/admin/command/global.
 */
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const parsed = commandRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("Geçersiz komut gövdesi", 422, parsed.error.flatten());
  }

  const cmd = parsed.data;
  const { customer } = ctx;

  let requestId: string;
  let seq: number;
  try {
    ({ requestId, seq } = publishCommand("customer", customer.slug, cmd, customer.zoneSlugs));
  } catch (err) {
    return fail("Toplu komut yayınlanamadı", 502, String(err));
  }

  after(() =>
    recordCommand("customer", customer.slug, requestId, seq, cmd, {
      userId: ctx.user.id,
      customerId: customer.id,
    }).catch((err) => console.error("[cmd] müşteri toplu komut kaydı başarısız:", err)),
  );

  return ok(
    { requestId, seq, status: "pending", zones: customer.zoneSlugs.length },
    { status: 202 },
  );
}
