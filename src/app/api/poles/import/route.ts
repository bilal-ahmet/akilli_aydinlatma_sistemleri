import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeScope } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { normalizeMac } from "@/lib/mac";
import { parseCoord, parsePoleImport } from "@/lib/poleImport";
import { inTurkey } from "@/app/_lib/poles";
import type { ImportResultRow } from "@/app/_lib/types";

export const runtime = "nodejs";

const MAX_TEXT = 3_000_000;
const MAX_ROWS = 10_000;
const INSERT_CHUNK = 500;

const bodySchema = z.object({
  text: z.string().max(MAX_TEXT, "Dosya çok büyük (en fazla 3 MB)"),
  fileName: z.string().max(200).optional(),
  /** Dosyada bölge sütunu yoksa yeni direklerin bölgesi (slug). */
  defaultZone: z.string().max(100).optional(),
  /** false → yalnızca önizleme. */
  apply: z.boolean().optional(),
});

interface Planned {
  line: number;
  code: string;
  existingId: string | null;
  zoneId: string | null; // null → mevcut bölge kalır (güncelleme)
  lat: number | null;
  lng: number | null;
  mac: string | null;
  name: string;
  notes: string;
}

/**
 * POST /api/poles/import?customer=<slug> — direk listesini içe aktarır.
 *
 * Önce `apply: false` ile önizleme alınır: her satır yeni / güncellenecek /
 * hata olarak döner. Hata yoksa `apply: true` hepsini tek transaction'da
 * uygular; hata varsa hiçbir şey yazılmaz. Eşleştirme direk numarasıyla
 * (müşteri içinde, büyük/küçük harf duyarsız); güncellemede boş hücre mevcut
 * değeri silmez.
 *
 * Koordinatlar WGS84 ondalık derece olmalı. Belediye CBS verisi çoğu zaman
 * ITRF96/TM projeksiyonundadır (metre cinsinden büyük sayılar) — bunlar
 * Türkiye kutusu dışında kaldığı için açık bir mesajla reddedilir.
 */
export async function POST(req: Request) {
  const ctx = await authorizeScope(req, "write");
  if (ctx instanceof Response) return ctx;

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return fail(body.error.issues[0]?.message ?? "Geçersiz istek", 422);

  const parsed = parsePoleImport(body.data.text, body.data.fileName);
  if ("error" in parsed) return fail(parsed.error, 422);
  if (parsed.rows.length === 0) return fail("Dosyada direk satırı yok.", 422);
  if (parsed.rows.length > MAX_ROWS) return fail(`En fazla ${MAX_ROWS} satır içe aktarılabilir.`, 422);

  // Müşterinin bölgeleri, direkleri ve cihazları (tek seferde).
  const zones = await db
    .select({ id: schema.zones.id, slug: schema.zones.slug, name: schema.zones.name })
    .from(schema.zones)
    .where(eq(schema.zones.customerId, ctx.customer.id));
  const zoneIds = zones.map((z) => z.id);
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneByKey = new Map<string, (typeof zones)[number]>();
  for (const z of zones) {
    zoneByKey.set(z.slug.toLocaleLowerCase("tr"), z);
    zoneByKey.set(z.name.trim().toLocaleLowerCase("tr"), z);
  }
  const existing = zoneIds.length
    ? await db
        .select({ id: schema.poles.id, code: schema.poles.code, zoneId: schema.poles.zoneId })
        .from(schema.poles)
        .where(inArray(schema.poles.zoneId, zoneIds))
    : [];
  const poleByCode = new Map(existing.map((p) => [p.code.toLocaleLowerCase("tr"), p]));
  const devs = zoneIds.length
    ? await db
        .select({ mac: schema.devices.deviceId, zoneId: schema.devices.zoneId, poleId: schema.devices.poleId })
        .from(schema.devices)
        .where(inArray(schema.devices.zoneId, zoneIds))
    : [];
  const devByMac = new Map(devs.map((d) => [d.mac, d]));
  const deviceOnPole = new Map(devs.filter((d) => d.poleId).map((d) => [d.poleId!, d.mac]));

  const defaultZone = body.data.defaultZone
    ? zones.find((z) => z.slug === body.data.defaultZone)
    : undefined;

  const seenCodes = new Map<string, number>();
  const seenMacs = new Map<string, number>();
  const result: ImportResultRow[] = [];
  const plan: Planned[] = [];

  for (const r of parsed.rows) {
    const errors: string[] = [];
    const code = r.code.trim();
    const key = code.toLocaleLowerCase("tr");
    const prev = code ? poleByCode.get(key) : undefined;

    if (!code) errors.push("Direk numarası boş");
    else if (code.length > 50) errors.push("Direk numarası 50 karakteri geçemez");
    else if (seenCodes.has(key)) errors.push(`Aynı numara ${seenCodes.get(key)}. satırda da var`);
    else seenCodes.set(key, r.line);

    // Bölge
    let zone = r.zone ? zoneByKey.get(r.zone.trim().toLocaleLowerCase("tr")) : undefined;
    if (r.zone && !zone) errors.push(`Bölge bulunamadı: ${r.zone}`);
    if (!r.zone && !prev) {
      zone = defaultZone;
      if (!zone) errors.push("Bölge boş");
    }
    const targetZoneId = zone?.id ?? prev?.zoneId ?? null;

    // Konum
    const lat = parseCoord(r.lat);
    const lng = parseCoord(r.lng);
    if ((lat === null) !== (lng === null)) errors.push("Enlem ve boylam birlikte girilmeli");
    else if (lat !== null && lng !== null) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) errors.push("Konum sayı değil");
      else if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || !inTurkey(lat, lng)) {
        errors.push(
          "Konum Türkiye dışında. Koordinatlar enlem/boylam (WGS84, ör. 40,7654 / 29,9408) olmalı; dosya farklı bir koordinat sisteminde olabilir",
        );
      }
    }

    // Cihaz
    let mac: string | null = null;
    if (r.mac) {
      mac = normalizeMac(r.mac);
      const dev = mac ? devByMac.get(mac) : undefined;
      if (!mac || !dev) errors.push(`Cihaz bulunamadı: ${r.mac}`);
      else if (targetZoneId && dev.zoneId !== targetZoneId) errors.push("Cihaz başka bir bölgede");
      else if (dev.poleId && dev.poleId !== prev?.id) errors.push("Cihaz başka bir direğe bağlı");
      if (mac && seenMacs.has(mac)) errors.push(`Aynı cihaz ${seenMacs.get(mac)}. satırda da var`);
      else if (mac) seenMacs.set(mac, r.line);
    } else if (prev && zone && zone.id !== prev.zoneId && deviceOnPole.has(prev.id)) {
      errors.push("Direğe bağlı cihaz var; bölge değiştirilemez");
    }

    if (r.name.length > 100) errors.push("Ad 100 karakteri geçemez");
    if (r.notes.length > 1000) errors.push("Not 1000 karakteri geçemez");

    const zoneName = targetZoneId ? (zoneById.get(targetZoneId)?.name ?? null) : null;
    result.push({
      line: r.line,
      code,
      action: errors.length ? "error" : prev ? "update" : "create",
      zoneName,
      hasLocation: lat !== null && lng !== null,
      mac,
      message: errors.length ? errors.join(" · ") : null,
    });
    if (!errors.length) {
      plan.push({
        line: r.line,
        code,
        existingId: prev?.id ?? null,
        zoneId: zone?.id ?? null,
        lat,
        lng,
        mac,
        name: r.name,
        notes: r.notes,
      });
    }
  }

  const summary = {
    total: result.length,
    create: result.filter((x) => x.action === "create").length,
    update: result.filter((x) => x.action === "update").length,
    error: result.filter((x) => x.action === "error").length,
  };

  if (!body.data.apply || summary.error > 0) {
    return ok({ rows: result, summary, columns: parsed.columns, applied: false });
  }

  try {
    const now = new Date();
    await db.transaction(async (tx) => {
      const idByLine = new Map<number, string>();

      const creates = plan.filter((p) => !p.existingId);
      for (let i = 0; i < creates.length; i += INSERT_CHUNK) {
        const chunk = creates.slice(i, i + INSERT_CHUNK);
        const inserted = await tx
          .insert(schema.poles)
          .values(
            chunk.map((p) => ({
              zoneId: p.zoneId!,
              code: p.code,
              name: p.name || null,
              notes: p.notes || null,
              lat: p.lat,
              lng: p.lng,
              locationSource: p.lat !== null ? "import" : null,
            })),
          )
          .returning({ id: schema.poles.id, code: schema.poles.code });
        // RETURNING sırasına güvenme: numara dosya içinde benzersiz (doğrulandı).
        const lineByCode = new Map(chunk.map((p) => [p.code, p.line]));
        for (const row of inserted) idByLine.set(lineByCode.get(row.code)!, row.id);
      }

      for (const p of plan.filter((x) => x.existingId)) {
        idByLine.set(p.line, p.existingId!);
        const patch: Partial<typeof schema.poles.$inferInsert> = { updatedAt: now };
        if (p.zoneId) patch.zoneId = p.zoneId;
        if (p.name) patch.name = p.name;
        if (p.notes) patch.notes = p.notes;
        if (p.lat !== null && p.lng !== null) {
          patch.lat = p.lat;
          patch.lng = p.lng;
          patch.locationSource = "import";
          patch.locationAccuracyM = null;
        }
        await tx.update(schema.poles).set(patch).where(eq(schema.poles.id, p.existingId!));
      }

      for (const p of plan.filter((x) => x.mac)) {
        const poleId = idByLine.get(p.line)!;
        await tx.update(schema.devices).set({ poleId: null }).where(eq(schema.devices.poleId, poleId));
        await tx.update(schema.devices).set({ poleId }).where(eq(schema.devices.deviceId, p.mac!));
      }
    });
    await audit({
      req,
      user: ctx.user,
      customerId: ctx.customer.id,
      action: "pole.import",
      target: body.data.fileName ?? null,
      detail: summary,
    });
    return ok({ rows: result, summary, columns: parsed.columns, applied: true });
  } catch (err) {
    return fail("Direkler içe aktarılamadı", 500, String(err));
  }
}
