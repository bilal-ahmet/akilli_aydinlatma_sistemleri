import { inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { effectByNumber } from "@/lib/effects";
import {
  publishCommand,
  recordCommand,
  type CommandInput,
  type CommandMeta,
  type CommandTarget,
} from "@/lib/mqtt";
import { getTenancy, type CustomerInfo } from "@/lib/tenancy";
import type { ScheduleResult, ScheduleTarget } from "@/lib/scheduleTime";
import { zoneSyncView } from "@/lib/zoneSync/engine";

/**
 * Bir hedef planını sunucuda yürütür (zamanlanmış komutlar). Kurallar
 * istemcideki `LightingProvider` + `planTargets` / `planStop` ile aynıdır:
 *
 *  - `all` → müşterinin "Tüm Sistem"i (bölge topic'lerine fanout).
 *  - `zones` → tek bölge publish (Kural #3), `devices` → kanalsız, `lamps` →
 *    kanallı cihaz komutu.
 *  - `groups` (alt grup) → bütün üyeler grubu cihazına uygulamışsa (senkron)
 *    tek grup publish'i; değilse üyelere cihaz komutu (grup topic'i senkron
 *    olmayan üyeye ulaşmaz). Çok lambalı efektte lambası yetmeyen üye varsa
 *    da cihaz komutlarına düşülür (o üye atlanır).
 *  - Müşteriye ait olmayan bölge/MAC (silinmiş, taşınmış) atlanır.
 *  - Çok lambalı efekt lamba hedefini cihazın tamamına yükseltir; lambası
 *    `minLamps`'ten az olan cihaz atlanır.
 *  - Çok lambalı efekt çalışan cihazda lamba komutundan ÖNCE efekt kanalsız
 *    `dim` ile cihazın tamamında durdurulur. Aynı topic + QoS 2 → MQTT sırayı
 *    korur; `recordCommand`'lar da sırayla beklenir.
 *
 * Komut yolu değildir (Kural #10 istek route'ları için): planı çözmek için
 * DB okunur, ama her komut yine önce publish, sonra kayıt.
 */

export type PlanOp =
  | { kind: "command"; cmd: CommandInput }
  | { kind: "stop_fx" };

type LampRow = { deviceId: string; channel: number; brightness: number; activeFx: number | null };

const fallback = (b: number | null | undefined) => (b != null && b > 0 ? b : 100);

export async function runPlan(
  customer: CustomerInfo,
  target: ScheduleTarget,
  op: PlanOp,
  meta: CommandMeta,
): Promise<ScheduleResult> {
  const idx = await getTenancy();
  let sent = 0;
  let skipped = 0;

  async function send(type: CommandTarget, id: string, cmd: CommandInput) {
    const { requestId, seq } = publishCommand(type, id, cmd, customer.zoneSlugs);
    sent++;
    await recordCommand(type, id, requestId, seq, cmd, meta).catch((err) =>
      console.error("[schedule] komut kaydı başarısız:", err),
    );
  }

  // ── Hedefleri müşteriye göre süz ──
  const all = "all" in target;
  const zoneSlugs = all ? customer.zoneSlugs : target.zones;
  const zones = zoneSlugs.filter((s) => idx.zoneOwner.get(s) === customer.id);
  const ownsMac = (mac: string) => idx.deviceOwner.get(mac) === customer.id;
  const devices = all ? [] : target.devices.filter(ownsMac);
  const lampRefs = all ? [] : target.lamps.filter((l) => ownsMac(l.mac));
  const groupSlugs = all ? [] : (target.groups ?? []);
  const ownedGroups = groupSlugs.filter((s) => idx.groupOwner.get(s) === customer.id);
  if (!all) {
    skipped +=
      target.zones.length - zones.length +
      groupSlugs.length - ownedGroups.length +
      target.devices.length - devices.length +
      target.lamps.length - lampRefs.length;
  }

  // Alt gruplar: tüm üyeler senkronsa grup topic'i, değilse üyelere cihaz komutu.
  let directGroups: string[] = [];
  const groupMembersOf = (slug: string) => idx.groupMacs.get(slug) ?? [];
  for (const slug of ownedGroups) {
    const members = groupMembersOf(slug);
    if (members.length === 0) continue;
    if (members.every((m) => zoneSyncView(m).status === "synced")) directGroups.push(slug);
    else for (const m of members) if (!devices.includes(m)) devices.push(m);
  }
  const viaGroup = new Set(directGroups.flatMap(groupMembersOf));

  // ── Anlık durum (efekt, şiddet) ──
  const macs = [...new Set([...devices, ...viaGroup, ...lampRefs.map((l) => l.mac)])];
  // Hedef bölgeler + cihaz/lamba hedeflerinin bölgeleri (durdurma şiddeti için).
  const statusZones = [
    ...new Set([...zones, ...macs.map((m) => idx.deviceZone.get(m)).filter((z): z is string => !!z)]),
  ];
  const zoneRows = statusZones.length
    ? await db
        .select({ slug: schema.zones.slug, brightness: schema.zones.brightness, activeFx: schema.zones.activeFx })
        .from(schema.zones)
        .where(inArray(schema.zones.slug, statusZones))
    : [];
  const zoneOf = new Map(zoneRows.map((z) => [z.slug, z]));
  // `all`/bölge efekti durdururken bölgedeki cihazların efekti de sorulur.
  const zoneMacs =
    op.kind === "stop_fx"
      ? [...idx.deviceZone].filter(([, z]) => zones.includes(z)).map(([m]) => m)
      : [];
  const lampMacs = [...new Set([...macs, ...zoneMacs])];
  const lampRows: LampRow[] = lampMacs.length
    ? await db
        .select({
          deviceId: schema.fixtures.deviceId,
          channel: schema.fixtures.channel,
          brightness: schema.fixtures.brightness,
          activeFx: schema.fixtures.activeFx,
        })
        .from(schema.fixtures)
        .where(inArray(schema.fixtures.deviceId, lampMacs))
    : [];
  const lampsOf = (mac: string) => lampRows.filter((l) => l.deviceId === mac);
  const runsGroupFx = (mac: string) => lampsOf(mac).some((l) => effectByNumber(l.activeFx)?.allLamps);
  const zoneBrightness = (mac: string) => fallback(zoneOf.get(idx.deviceZone.get(mac) ?? "")?.brightness);

  // Çok lambalı efektte lambası yetmeyen üyeli grup cihaz komutlarına düşer.
  const fxOp = op.kind === "command" && op.cmd.action === "efekt" ? effectByNumber(op.cmd.number) : undefined;
  if (fxOp?.allLamps) {
    directGroups = directGroups.filter((slug) => {
      const ok = groupMembersOf(slug).every((m) => lampsOf(m).length >= (fxOp.minLamps ?? 1));
      if (!ok) for (const m of groupMembersOf(slug)) if (!devices.includes(m)) devices.push(m);
      return ok;
    });
  }
  const groupCovered = new Set(directGroups.flatMap(groupMembersOf));
  const restDevices = devices.filter((m) => !groupCovered.has(m));

  // ── Efekti durdur: yalnızca efekt çalışan hedefler ──
  if (op.kind === "stop_fx") {
    for (const slug of directGroups) {
      const members = groupMembersOf(slug);
      if (members.some((m) => lampsOf(m).some((l) => l.activeFx != null))) {
        await send("group", slug, { action: "dim", value: zoneBrightness(members[0]) });
      }
    }
    for (const slug of zones) {
      const z = zoneOf.get(slug);
      const busy =
        z?.activeFx != null ||
        zoneMacs.some((m) => idx.deviceZone.get(m) === slug && lampsOf(m).some((l) => l.activeFx != null));
      if (busy) await send("zone", slug, { action: "dim", value: fallback(z?.brightness) });
    }
    const wholeDevices = new Set(restDevices);
    const singleLamps: LampRow[] = [];
    for (const r of lampRefs) {
      if (runsGroupFx(r.mac)) wholeDevices.add(r.mac);
      else {
        const l = lampsOf(r.mac).find((x) => x.channel === r.channel);
        if (l?.activeFx != null) singleLamps.push(l);
      }
    }
    for (const mac of wholeDevices) {
      if (lampsOf(mac).some((l) => l.activeFx != null)) {
        await send("device", mac, { action: "dim", value: zoneBrightness(mac) });
      }
    }
    for (const l of singleLamps) {
      await send("device", l.deviceId, { action: "dim", value: fallback(l.brightness), channel: l.channel });
    }
    return { sent, skipped };
  }

  const { cmd } = op;
  if (all) {
    await send("customer", customer.slug, cmd);
    return { sent, skipped };
  }

  for (const slug of zones) await send("zone", slug, cmd);
  for (const slug of directGroups) await send("group", slug, cmd);

  const fx = cmd.action === "efekt" ? effectByNumber(cmd.number) : undefined;
  if (fx?.allLamps) {
    // Çok lambalı efekt kanal kabul etmez: lamba seçimi cihazın tamamına çıkar.
    for (const mac of new Set([...restDevices, ...lampRefs.map((l) => l.mac).filter((m) => !groupCovered.has(m))])) {
      if (lampsOf(mac).length < (fx.minLamps ?? 1)) {
        skipped++;
        continue;
      }
      await send("device", mac, cmd);
    }
    return { sent, skipped };
  }

  for (const mac of restDevices) await send("device", mac, cmd);

  const stopped = new Set<string>();
  for (const r of lampRefs) {
    if (devices.includes(r.mac) || groupCovered.has(r.mac)) continue; // cihazın tamamı zaten komutu aldı
    if (runsGroupFx(r.mac) && !stopped.has(r.mac)) {
      stopped.add(r.mac);
      await send("device", r.mac, { action: "dim", value: zoneBrightness(r.mac) });
    }
    await send("device", r.mac, { ...cmd, channel: r.channel });
  }
  return { sent, skipped };
}
