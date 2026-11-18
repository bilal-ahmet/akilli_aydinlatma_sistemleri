/**
 * Dinamik bölge aboneliği — saf mantık (sunucu, istemci ve tsx betikleri).
 *
 * Cihazın dinlediği bölge topic'leri artık firmware'e gömülü değil: cihaz
 * listeyi NVS'te tutar, backend `Meven:<MAC>/cmd`'ye binary zone_add /
 * zone_remove / zone_clear / zone_list göndererek yönetir (firmware ekibinin
 * "Dinamik zone ve bölgesel OTA" planı).
 *
 * Model: backend komut KUYRUĞU değil İSTENEN DURUM saklar.
 *  - istenen  = cihazın bölge slug'ı + üyesi olduğu alt grupların slug'ları
 *               (silinmiş / kayıtsız ama daha önce yönetilmiş cihazda ∅)
 *  - bilinen  = cihazın son doğrulanmış listesi (null = bilinmiyor)
 * Her adımda fark yeniden hesaplanır ve TEK komut gönderilir; ack gelince
 * bilinen güncellenir, sıradaki hesaplanır. Kayıp/yinelenen komut sırayı
 * bozamaz, çünkü her adım güncel bilinen durumdan türetilir. Komutlar
 * idempotent ve ya-hep-ya-hiç olduğu için tekrar göndermek güvenlidir.
 */
import {
  ZONES_PER_COMMAND,
  ZONES_PER_DEVICE,
  isDeviceZoneSlug,
  type ZoneCommandAction,
} from "@/lib/binproto/command";

export { ZONES_PER_COMMAND, ZONES_PER_DEVICE, isDeviceZoneSlug };

/**
 * Cihazın bölge aboneliği durumu:
 *  - unknown      henüz doğrulanmadı / cihaz bu özelliği konuşmadı (eski firmware)
 *  - pending      fark var, komutlar gidiyor (ya da izleme modunda bekliyor)
 *  - synced       cihazın listesi istenenle aynı
 *  - error        cihaz reddetti ya da slug cihaz kuralına uymuyor (insan bakmalı)
 *  - unsupported  firmware zone komutlarını tanımıyor (sürüm değişince yeniden denenir)
 *  - no_response  komut yanıtsız kaldı; cihaz bağlandığında (HELLO) sürer
 */
export const ZONE_SYNC_STATUSES = [
  "unknown",
  "pending",
  "synced",
  "error",
  "unsupported",
  "no_response",
] as const;
export type ZoneSyncStatus = (typeof ZONE_SYNC_STATUSES)[number];

/** `MQTT_ZONE_SYNC`: on (varsayılan) · observe (yalnızca zone_list) · off. */
export type ZoneSyncMode = "on" | "observe" | "off";

/** API / SSE'de cihazın bölge senkron durumu. `desired`/`reported` yalnızca admin'e. */
export type ZoneSyncView = {
  status: ZoneSyncStatus;
  /** Son hata (ham firmware metni ya da backend açıklaması). */
  error?: string | null;
  errorAt?: string | null;
  desired?: string[];
  reported?: string[] | null;
  reportedAt?: string | null;
};

export type ZoneOp = { action: ZoneCommandAction; zones: string[] };

const chunks = (list: readonly string[], size = ZONES_PER_COMMAND): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** İstenen topic listesi: bölge + alt gruplar (tekrarsız, sıra korunur). */
export function desiredZones(
  zoneSlug: string | null | undefined,
  groupSlugs: readonly string[] | null | undefined,
): string[] {
  const out: string[] = [];
  for (const s of [zoneSlug, ...(groupSlugs ?? [])]) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function sameZoneSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((z) => set.has(z));
}

/**
 * Bilinenden istenene giden komutlar (sırasıyla). Bilinmiyorsa önce
 * `zone_list`. Çıkarmalar eklemelerden önce gelir (16 sınırı geçici olarak
 * aşılmasın, eski bölgenin komutu yeni bölgeyle karışmasın). Daha az paket
 * tutuyorsa `zone_clear` + eklemeler; istenen boşsa tek `zone_clear`.
 * Geçersiz slug'lar çağıran tarafından ayıklanmış olmalı.
 */
export function planZoneOps(reported: readonly string[] | null, desired: readonly string[]): ZoneOp[] {
  if (reported === null) return [{ action: "zone_list", zones: [] }];
  const want = new Set(desired);
  const have = new Set(reported);
  const removes = reported.filter((z) => !want.has(z));
  const adds = desired.filter((z) => !have.has(z));
  if (removes.length === 0 && adds.length === 0) return [];
  if (desired.length === 0) return [{ action: "zone_clear", zones: [] }];

  const incremental: ZoneOp[] = [
    ...chunks(removes).map((zones) => ({ action: "zone_remove" as const, zones })),
    ...chunks(adds).map((zones) => ({ action: "zone_add" as const, zones })),
  ];
  const rebuild: ZoneOp[] = [
    { action: "zone_clear", zones: [] },
    ...chunks(desired).map((zones) => ({ action: "zone_add" as const, zones })),
  ];
  return rebuild.length < incremental.length ? rebuild : incremental;
}

/** Başarılı ack'ten sonra cihazdaki liste. `zone_list`'te ack'in listesi. */
export function applyZoneOp(
  reported: readonly string[],
  op: ZoneOp,
  ackZones?: readonly string[],
): string[] {
  switch (op.action) {
    case "zone_add":
      return [...reported, ...op.zones.filter((z) => !reported.includes(z))];
    case "zone_remove":
      return reported.filter((z) => !op.zones.includes(z));
    case "zone_clear":
      return [];
    case "zone_list":
      return [...(ackZones ?? [])];
  }
}

/**
 * Cihazın reddettiği zone komutunun akıbeti (firmware sonuç kodu):
 *  - retry       geçici: -14 kuyruk dolu, -15 CRC, -20 NVS yazılamadı
 *  - unsupported -5 bilinmeyen action: firmware zone komutlarını tanımıyor
 *  - fatal       -18 geçersiz slug, -19 sınır, -21 yanlış topic, -16/-17 biçim…
 */
export function classifyZoneResult(code: number | undefined): "retry" | "unsupported" | "fatal" {
  if (code === -14 || code === -15 || code === -20) return "retry";
  if (code === -5) return "unsupported";
  return "fatal";
}

/** Durum, müşteri dilinde (DeviceTable alt satırı); senkron/bilinmiyorsa null. */
export function zoneSyncLabel(
  view: Pick<ZoneSyncView, "status"> | null | undefined,
  technical: boolean,
): { text: string; tone: "warn" | "bad" | "idle" } | null {
  switch (view?.status) {
    case "pending":
      return { text: technical ? "Zone listesi gönderiliyor" : "Bölge bilgisi gönderiliyor", tone: "warn" };
    case "no_response":
      return {
        text: technical
          ? "Zone komutu yanıtsız — HELLO'da sürecek"
          : "Bölge bilgisi cihaz bağlandığında uygulanacak",
        tone: "warn",
      };
    case "error":
      return { text: technical ? "Zone listesi uygulanamadı" : "Bölge bilgisi uygulanamadı", tone: "bad" };
    case "unsupported":
      return technical ? { text: "Firmware zone komutlarını desteklemiyor", tone: "idle" } : null;
    default:
      return null;
  }
}

/** Bu cihaz dinamik bölge aboneliğini konuşuyor mu (bölge değişikliği uyarısı için). */
export function zoneSyncCapable(view: Pick<ZoneSyncView, "status"> | null | undefined): boolean {
  const s = view?.status;
  return s === "synced" || s === "pending" || s === "no_response" || s === "error";
}
