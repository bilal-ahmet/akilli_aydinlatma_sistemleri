import type { DeviceView, LampView, Zone } from "./types";
import { effectByNumber, type Effect } from "@/lib/effects";

/**
 * Toplu kontrol için cihaz/lamba seçimi — Bölge detayı ve Efektler sayfası
 * aynı modeli kullanır. SAF modül: React'e bağlı değil, her fonksiyon yeni bir
 * seçim döner.
 *
 *   anahtar yok   → cihaz seçili değil
 *   null          → cihazın TAMAMI (kanalsız cihaz komutu)
 *   Set<channel>  → yalnızca bu lambalar (kanallı cihaz komutları)
 *
 * Bütün lambaları tek tek seçilen cihaz otomatik olarak `null`'a döner; böylece
 * komut planı gereksiz yere lamba lamba gitmez.
 */
export type Selection = Map<string, Set<number> | null>;

export interface LampRef {
  mac: string;
  channel: number;
}

/** Komut hedefleri: bölge (tek publish), cihazın tamamı, tek lamba. */
export interface CommandTargets {
  zones?: string[];
  devices?: string[];
  lamps?: LampRef[];
}

export type SelState = "none" | "some" | "all";

export function emptySelection(): Selection {
  return new Map();
}

export function deviceSelState(sel: Selection, d: DeviceView): SelState {
  const s = sel.get(d.deviceId);
  if (s === undefined) return "none";
  if (s === null) return "all";
  return s.size > 0 ? "some" : "none";
}

export function isLampSelected(sel: Selection, mac: string, channel: number): boolean {
  const s = sel.get(mac);
  return s === null || (s instanceof Set && s.has(channel));
}

/** Tam seçili cihaz kaldırılır; seçili olmayan ya da yarı seçili cihaz tamamen seçilir. */
export function toggleDevice(sel: Selection, d: DeviceView): Selection {
  const next = new Map(sel);
  if (deviceSelState(sel, d) === "all") next.delete(d.deviceId);
  else next.set(d.deviceId, null);
  return next;
}

export function toggleLamp(sel: Selection, d: DeviceView, channel: number): Selection {
  const channels = d.lamps.map((l) => l.channel);
  const cur = sel.get(d.deviceId);
  const set = new Set(cur === undefined ? [] : cur === null ? channels : cur);
  if (set.has(channel)) set.delete(channel);
  else set.add(channel);
  const next = new Map(sel);
  if (set.size === 0) next.delete(d.deviceId);
  else if (channels.every((c) => set.has(c))) next.set(d.deviceId, null);
  else next.set(d.deviceId, set);
  return next;
}

/** `devices` içindeki seçimi `devices`'tan seçilenlerle değiştirir; dışarıdaki seçim korunur. */
export function replaceWithin(
  sel: Selection,
  devices: DeviceView[],
  pick: (d: DeviceView) => boolean,
): Selection {
  const next = new Map(sel);
  for (const d of devices) {
    if (pick(d)) next.set(d.deviceId, null);
    else next.delete(d.deviceId);
  }
  return next;
}

/**
 * Artık listede olmayan cihazları (silinen/taşınan) ve artık olmayan lambaları
 * seçimden atar. Render'da çağrılır; değişiklik yoksa aynı nesneyi döner.
 */
export function pruneSelection(sel: Selection, devices: DeviceView[]): Selection {
  const byMac = new Map(devices.map((d) => [d.deviceId, d]));
  let changed = false;
  const next: Selection = new Map();
  for (const [mac, s] of sel) {
    const d = byMac.get(mac);
    if (!d) {
      changed = true;
      continue;
    }
    if (s === null) {
      next.set(mac, null);
      continue;
    }
    const valid = new Set([...s].filter((ch) => d.lamps.some((l) => l.channel === ch)));
    if (valid.size !== s.size) changed = true;
    if (valid.size > 0) next.set(mac, valid);
  }
  return changed ? next : sel;
}

export interface SelectionCount {
  /** Tamamı seçili cihaz sayısı. */
  devices: number;
  /** Yarı seçili cihazlarda seçili lamba sayısı. */
  lamps: number;
}

export function countSelection(sel: Selection): SelectionCount {
  let devices = 0;
  let lamps = 0;
  for (const s of sel.values()) {
    if (s === null) devices += 1;
    else lamps += s.size;
  }
  return { devices, lamps };
}

/** "3 cihaz", "1 lamba", "2 cihaz ve 1 lamba". */
export function selectionText({ devices, lamps }: SelectionCount): string {
  const parts: string[] = [];
  if (devices) parts.push(`${devices} cihaz`);
  if (lamps) parts.push(`${lamps} lamba`);
  return parts.join(" ve ");
}

// ── Durum (lambalardan türetilir) ─────────────────────────────

export interface LightState {
  /** null: bilinmiyor (cihaz henüz lamba raporlamadı ve telemetri yok). */
  isOn: boolean | null;
  /** Açık lambaların ortalama şiddeti (0–100); hepsi kapalıysa 0. */
  brightness: number;
  /** Lambalardan birinde çalışan efekt (kanal sırasıyla ilki). */
  activeFx: number | null;
}

/**
 * Lamba yanıyor mu? Efekt çalışan lamba yanıyor sayılır. Efekt yoksa şiddeti
 * 0 olan lamba kapalıdır: sunucu `dim 0`'ı "açık, %0" olarak kaydeder
 * (patchFor) ve bazı sürücüler seviye 0'da güç bayrağını açık bırakır.
 */
export function lampOn(l: Pick<LampView, "isOn" | "brightness" | "activeFx">): boolean {
  return l.activeFx != null || (l.isOn && l.brightness > 0);
}

/**
 * Cihazın ışık durumu. Lambalar `fixtures` snapshot'ından gelir: komutla
 * optimistic, cihaz raporuyla da gerçek değere güncellenir. Lamba kaydı yoksa
 * son telemetriye (`device_status`) düşülür.
 */
export function deviceState(d: DeviceView): LightState {
  if (d.lamps.length === 0) {
    return {
      isOn: d.relayStatus === "on" ? true : d.relayStatus === "off" ? false : null,
      brightness: d.brightness ?? 0,
      activeFx: d.activeFx,
    };
  }
  const on = d.lamps.filter(lampOn);
  return {
    isOn: on.length > 0,
    brightness: on.length
      ? Math.round(on.reduce((a, l) => a + l.brightness, 0) / on.length)
      : 0,
    activeFx: d.lamps.find((l) => l.activeFx != null)?.activeFx ?? null,
  };
}

/** Cihazda tüm hattı süren (çok lambalı) bir efekt çalışıyor mu? */
export function runsGroupEffect(d: DeviceView): boolean {
  return d.lamps.some((l) => effectByNumber(l.activeFx)?.allLamps === true);
}

/** Lambanın görünen adı: verilmiş isim, yoksa "Lamba <kanal>". */
export function lampName(l: LampView): string {
  return l.name?.trim() || `Lamba ${l.channel}`;
}

// ── Komut planı ───────────────────────────────────────────────

export interface TargetPlan {
  zones: string[];
  devices: string[];
  lamps: LampRef[];
  /** Lambası efektin istediğinden az olduğu için atlanan cihazlar. */
  skipped: string[];
}

export function isEmptyPlan(p: { zones: string[]; devices: string[]; lamps: LampRef[] }): boolean {
  return p.zones.length === 0 && p.devices.length === 0 && p.lamps.length === 0;
}

/** Lambası bu efektin istediğinden az mı? Lamba kaydı yoksa sayı bilinmez; engellenmez. */
export function tooFewLamps(d: DeviceView, effect: Effect | undefined): boolean {
  return effect?.minLamps != null && d.lampCount > 0 && d.lampCount < effect.minLamps;
}

/**
 * Seçimi komut hedeflerine çevirir:
 *  - Çok lambalı efekt (`allLamps`) kanal kabul etmez → lamba seçimi cihazın
 *    tamamına yükseltilir. Lambası yetmeyen cihaz atlanır (`skipped`).
 *  - Bölgenin bütün cihazları tamamen seçiliyse tek bölge komutu gider
 *    (Kural #3); o cihazlar ayrıca komut almaz.
 */
export function planTargets(
  sel: Selection,
  devices: DeviceView[],
  zones: Zone[],
  effect?: Effect,
): TargetPlan {
  const whole = new Set<string>();
  const lamps: LampRef[] = [];
  const skipped: string[] = [];

  for (const d of devices) {
    const s = sel.get(d.deviceId);
    if (s === undefined) continue;
    if (tooFewLamps(d, effect)) {
      skipped.push(d.deviceId);
      continue;
    }
    if (s === null || effect?.allLamps) whole.add(d.deviceId);
    else for (const channel of s) lamps.push({ mac: d.deviceId, channel });
  }

  const zoneIds: string[] = [];
  for (const z of zones) {
    const inZone = devices.filter((d) => d.zoneSlug === z.id);
    if (inZone.length > 0 && inZone.every((d) => whole.has(d.deviceId))) {
      zoneIds.push(z.id);
      for (const d of inZone) whole.delete(d.deviceId);
    }
  }

  return { zones: zoneIds, devices: [...whole], lamps, skipped };
}

/**
 * Efekt durdurma hedefleri: seçimin yalnızca efekt ÇALIŞAN kısımları. Bölge,
 * kendisinde ya da cihazlarından birinde efekt varsa bölge olarak durdurulur.
 */
export function planStop(sel: Selection, devices: DeviceView[], zones: Zone[]): TargetPlan {
  const p = planTargets(sel, devices, zones);
  const byMac = new Map(devices.map((d) => [d.deviceId, d]));
  return {
    zones: p.zones.filter((id) => {
      const z = zones.find((x) => x.id === id);
      return (
        z?.activeFx != null ||
        devices.some((d) => d.zoneSlug === id && deviceState(d).activeFx != null)
      );
    }),
    devices: p.devices.filter((mac) => {
      const d = byMac.get(mac);
      return d ? deviceState(d).activeFx != null : false;
    }),
    lamps: p.lamps.filter(({ mac, channel }) => {
      const d = byMac.get(mac);
      // Tüm hattı süren efekt tek lambadan durdurulsa da cihazın tamamında durur.
      return d ? runsGroupEffect(d) || d.lamps.some((l) => l.channel === channel && l.activeFx != null) : false;
    }),
    skipped: [],
  };
}
