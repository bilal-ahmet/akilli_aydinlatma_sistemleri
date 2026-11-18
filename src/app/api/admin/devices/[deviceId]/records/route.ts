import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ok, fail } from "@/lib/api/respond";
import { authorizeAdmin } from "@/lib/auth/guard";
import { normalizeMac } from "@/lib/mac";
import { flattenRecord, toCsv, trDateTime, type CsvRow } from "@/lib/csv";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 5000;

type Kind = "data" | "health" | "rf";
const KINDS: readonly Kind[] = ["data", "health", "rf"];

/** Ekrandaki ve JSON indirmesindeki kayıt biçimi. */
interface DeviceRecord {
  id: number;
  recordedAt: string | null;
  /** Yalnızca `data`: DALI adresi (lamba). */
  channel?: number;
  /** data: cihazın gönderdiği paket · health: health mesajı · rf: health'in `thread` bloğu. */
  payload: Record<string, unknown> | null;
}

/**
 * GET /api/admin/devices/:deviceId/records?kind=data|health|rf&limit=50&format=json|csv[&download=1]
 *
 * YALNIZCA ADMIN. Cihazın son N kaydı, yeniden eskiye:
 *  - data   → `d4i_telemetry` (lamba başına periyodik rapor, ham paket)
 *  - health → `device_health_log` (7 gün saklanır)
 *  - rf     → aynı health satırlarının Thread radyo bloğu
 * `format=csv` ya da `download=1` dosya olarak iner (Content-Disposition).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const user = await authorizeAdmin(req);
  if (user instanceof Response) return user;

  const { deviceId } = await params;
  const mac = normalizeMac(deviceId);
  if (!mac) return fail("Geçersiz MAC", 400);

  const sp = new URL(req.url).searchParams;
  const kind = (sp.get("kind") ?? "data") as Kind;
  if (!KINDS.includes(kind)) return fail("kind: data | health | rf", 400);
  const rawLimit = Number(sp.get("limit"));
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const format = sp.get("format") === "csv" ? "csv" : "json";
  const download = format === "csv" || sp.get("download") === "1";

  let records: DeviceRecord[];
  try {
    records = kind === "data" ? await readData(mac, limit) : await readHealth(mac, limit, kind);
  } catch (err) {
    return fail("Kayıtlar okunamadı", 500, String(err));
  }

  if (!download) return ok({ deviceId: mac, kind, limit, rows: records });

  const stamp = trDateTime(new Date()).replace(/[-: ]/g, "").slice(0, 12);
  const base = `${mac}-${kind}-${stamp}`;
  if (format === "csv") {
    return new Response(toCsv(records.map((r) => csvRow(kind, r)), csvLead(kind)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const body = JSON.stringify(
    { deviceId: mac, kind, exportedAt: new Date().toISOString(), count: records.length, rows: records },
    null,
    2,
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

async function readData(mac: string, limit: number): Promise<DeviceRecord[]> {
  const t = schema.d4iTelemetry;
  const rows = await db
    .select({ id: t.id, channel: t.channel, raw: t.raw, recordedAt: t.recordedAt })
    .from(t)
    .where(eq(t.deviceId, mac))
    .orderBy(desc(t.recordedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    recordedAt: r.recordedAt?.toISOString() ?? null,
    channel: r.channel,
    payload: (r.raw as Record<string, unknown> | null) ?? null,
  }));
}

async function readHealth(mac: string, limit: number, kind: "health" | "rf"): Promise<DeviceRecord[]> {
  const t = schema.deviceHealthLog;
  const rows = await db
    .select()
    .from(t)
    .where(eq(t.deviceId, mac))
    .orderBy(desc(t.recordedAt))
    .limit(limit);
  return rows.map((r) => {
    let payload: Record<string, unknown> | null = r.health;
    if (kind === "rf") {
      const thread = r.health?.thread;
      payload = thread && typeof thread === "object" ? (thread as Record<string, unknown>) : null;
    }
    return { id: r.id, recordedAt: r.recordedAt.toISOString(), payload };
  });
}

function csvLead(kind: Kind): string[] {
  if (kind === "data") return ["zaman", "kanal"];
  if (kind === "rf") return ["zaman", "neighbor_count"];
  return ["zaman"];
}

function csvRow(kind: Kind, r: DeviceRecord): CsvRow {
  const row: CsvRow = { zaman: r.recordedAt ? trDateTime(new Date(r.recordedAt)) : null };
  if (kind === "data") row.kanal = r.channel ?? null;
  if (kind === "rf") {
    const n = r.payload?.neighbors;
    row.neighbor_count = Array.isArray(n) ? n.length : null;
  }
  return { ...row, ...flattenRecord(r.payload ?? {}) };
}
