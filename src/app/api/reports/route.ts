import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import { parseReportRange, rangeErrorText } from "@/lib/reports/range";
import { buildEvents, buildReport, type ReportInput } from "@/lib/reports/build";
import { loadReportRows } from "@/lib/reports/query";
import { reportFileName, reportWorkbook } from "@/lib/reports/xlsx";

export const runtime = "nodejs";

/**
 * GET /api/reports?customer=<slug>&from=YYYY-MM-DD&to=YYYY-MM-DD[&zone=<slug>][&format=xlsx]
 *
 * Dönemlik rapor (en fazla 90 gün): arıza sıklığı ve türleri, arızalı kalma
 * süresi, enerji (sayaç farkı) ve yaklaşık yanma süresi — cihaz, bölge ve gün
 * kırılımıyla. Salt okunur; tüm roller (izleyici dahil).
 *
 * `format=xlsx` → Excel dosyası (ek olarak tek tek arıza kayıtları sayfası).
 * Metinler role göre: admin teknik, müşteri sade (`faultLabel`).
 * Başka müşterinin bölgesi 404 (varlık sızmaz).
 */
export async function GET(req: Request) {
  const ctx = await authorizeScope(req, "read");
  if (ctx instanceof Response) return ctx;

  const sp = new URL(req.url).searchParams;
  const now = new Date();
  const range = parseReportRange(sp.get("from"), sp.get("to"), now);
  if (!range.ok) return fail(rangeErrorText(range.error), 422);

  const zoneSlug = sp.get("zone") || null;
  if (zoneSlug && !ctx.customer.zoneSlugs.includes(zoneSlug)) return fail("Bölge bulunamadı", 404);
  const xlsx = sp.get("format") === "xlsx";
  const technical = ctx.user.role === "admin";

  try {
    const rows = await loadReportRows({ customerId: ctx.customer.id, zoneSlug, period: range.period });
    const zone = zoneSlug ? (rows.zones.find((z) => z.slug === zoneSlug) ?? null) : null;
    // Tenancy index'i bölgeyi tanıyor ama DB'de yoksa (aynı anda silindi).
    if (zoneSlug && !zone) return fail("Bölge bulunamadı", 404);

    const input: ReportInput = {
      period: range.period,
      customer: { slug: ctx.customer.slug, name: ctx.customer.name },
      zone,
      technical,
      now,
      ...rows,
    };
    const report = buildReport(input);
    if (!xlsx) return ok(report);

    const body = await reportWorkbook(report, buildEvents(input));
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${reportFileName(report)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return fail("Rapor oluşturulamadı", 500, String(err));
  }
}
