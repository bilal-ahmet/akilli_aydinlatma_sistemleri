import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { ScheduleRow } from "@/lib/db/schema";
import { effectByNumber } from "@/lib/effects";
import type { CustomerInfo, TenancyIndex } from "@/lib/tenancy";
import { nextRunAt, specOf, type ScheduleTarget } from "@/lib/scheduleTime";
import type { ScheduleInput } from "@/types/lighting";
import type { ScheduleView } from "@/app/_lib/types";

/** Zamanlama satırı → API görünümü. */
export function toScheduleView(r: ScheduleRow): ScheduleView {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    action: r.action as ScheduleView["action"],
    value: r.value,
    effectNumber: r.effectNumber,
    effectText: r.effectText,
    target: r.target,
    timeKind: r.timeKind as ScheduleView["timeKind"],
    timeMinutes: r.timeMinutes,
    offsetMinutes: r.offsetMinutes,
    repeat: r.repeat as ScheduleView["repeat"],
    runDate: r.runDate,
    weekdays: r.weekdays,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastResult: r.lastResult ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

export async function listSchedules(customerId: string): Promise<ScheduleView[]> {
  const rows = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.customerId, customerId))
    .orderBy(asc(schema.schedules.createdAt));
  return rows.map(toScheduleView);
}

export async function getScheduleRow(id: string): Promise<ScheduleRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await db.select().from(schema.schedules).where(eq(schema.schedules.id, id));
  return row;
}

/**
 * Hedefteki bölge/MAC'ler müşteriye ait mi? Değilse 422 metni döner (sahip
 * açıklanmaz). Çalışma anında da süzülür (`runPlan`); burada baştan yakalanır.
 */
export function checkTargetOwnership(
  target: ScheduleTarget,
  customer: CustomerInfo,
  idx: TenancyIndex,
): string | null {
  if ("all" in target) return null;
  const badZone = target.zones.some((s) => idx.zoneOwner.get(s) !== customer.id);
  const badMac = [...target.devices, ...target.lamps.map((l) => l.mac)].some(
    (m) => idx.deviceOwner.get(m) !== customer.id,
  );
  return badZone || badMac ? "Hedefte bulunamayan bölge ya da cihaz var" : null;
}

/**
 * Doğrulanmış girdiyi DB alanlarına çevirir: kullanılmayan alanlar
 * temizlenir, `next_run_at` hesaplanır. Zaman geçmişteyse `nextRunAt` null.
 */
export function scheduleValues(d: ScheduleInput, now: Date = new Date()) {
  const fixed = d.timeKind === "fixed";
  const once = d.repeat === "once";
  const fx = d.action === "efekt" ? effectByNumber(d.effectNumber) : undefined;
  const values = {
    name: d.name ? d.name : null,
    enabled: d.enabled ?? true,
    action: d.action,
    value: d.action === "dim" || d.action === "on" ? (d.value ?? null) : null,
    effectNumber: fx ? fx.number : null,
    effectText: fx?.needsText && d.effectText ? d.effectText : null,
    target: d.target as ScheduleTarget,
    timeKind: d.timeKind,
    timeMinutes: fixed ? (d.timeMinutes ?? null) : null,
    offsetMinutes: fixed ? 0 : d.offsetMinutes,
    repeat: d.repeat,
    runDate: once ? (d.runDate ?? null) : null,
    weekdays: once ? null : (d.weekdays ?? null),
  };
  return { ...values, nextRunAt: nextRunAt(specOf(values), now) };
}

/** PATCH için: satırı girdi şekline çevirir (gelen alanlar üstüne yazılır). */
export function rowAsInput(r: ScheduleRow): Record<string, unknown> {
  return {
    name: r.name,
    enabled: r.enabled,
    action: r.action,
    value: r.value,
    effectNumber: r.effectNumber,
    effectText: r.effectText,
    target: r.target,
    timeKind: r.timeKind,
    timeMinutes: r.timeMinutes,
    offsetMinutes: r.offsetMinutes,
    repeat: r.repeat,
    runDate: r.runDate,
    weekdays: r.weekdays,
  };
}
