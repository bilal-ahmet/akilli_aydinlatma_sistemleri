/**
 * MQTT topic şeması (ESP ekibinin kontratı):
 *   Meven:<MAC>/cmd   ← tekil komut (backend publish, cihaz subscribe)
 *   Meven:<slug>/cmd  ← bölge komutu (bölgedeki tüm cihazlar subscribe)
 *   Meven:all/cmd     ← toplu komut (tüm cihazlar subscribe)
 *   Meven:<MAC>/data  ← veri/durum + komut yanıtı (cihaz publish, backend subscribe)
 *   Meven:<MAC>/health← ~30 sn'de bir sağlık/OTA durumu (cihaz publish, backend subscribe)
 *   Meven:<MAC>/bin   ← binary protokol v1: yeni firmware'in TÜM uplink'i (bkz. lib/binproto)
 *
 * Bölge topic'i sayesinde bölge komutu tek publish'tir: backend cihaz listesini
 * DB'den çözmez, publish hiçbir sorgu beklemez. Cihaz kendi bölge slug'ını
 * firmware'deki ZONE_SLUG'tan bilir.
 *
 * Not: MQTT '+' joker'i bir seviyenin tamamını kapsar; "Meven:" bir seviyenin
 * parçası olduğundan "Meven:+/data" GEÇERSİZdir. Bu yüzden veri aboneliği
 * "+/data" olur; MAC topic'in kendisinden çözülür (macFromDataTopic).
 */
const PREFIX = "Meven";

export const cmdTopic = (mac: string) => `${PREFIX}:${mac}/cmd`;
export const zoneCmdTopic = (slug: string) => `${PREFIX}:${slug}/cmd`;
export const dataTopic = (mac: string) => `${PREFIX}:${mac}/data`;
export const healthTopic = (mac: string) => `${PREFIX}:${mac}/health`;
export const ALL_CMD = `${PREFIX}:all/cmd`;
export const DATA_WILDCARD = "+/data";
// Firmware 1.0.9+: ~30 sn'de bir sağlık mesajı (firmware sürümü, OTA durumu).
export const HEALTH_WILDCARD = "+/health";
// Binary protokol v1 (lib/binproto): yeni firmware TÜM uplink'ini buraya basar
// (/data ve /health'e artık yazmaz). Backend çözüp JSON yoluna verir.
export const binTopic = (mac: string) => `${PREFIX}:${mac}/bin`;
export const BIN_WILDCARD = "+/bin";

export type UplinkSuffix = "data" | "health";

/** "Meven:A842E3123456/bin" → "A842E3123456". Eşleşmezse null. */
export function parseBinTopic(topic: string): string | null {
  const m = /^Meven:([0-9A-Fa-f]{12})\/bin$/.exec(topic);
  return m ? m[1].toUpperCase() : null;
}

/**
 * "Meven:A842E3123456/data" → { mac: "A842E3123456", suffix: "data" }.
 * Cihazın yayınladığı yeni payload'larda (d4i_periodic, komut yanıtı, health)
 * `deviceId` alanı yok; kimlik yalnızca topic'te taşınıyor. Eşleşmezse null.
 */
export function parseUplinkTopic(topic: string): { mac: string; suffix: UplinkSuffix } | null {
  const m = /^Meven:([0-9A-Fa-f]{12})\/(data|health)$/.exec(topic);
  return m ? { mac: m[1].toUpperCase(), suffix: m[2] as UplinkSuffix } : null;
}

/** "Meven:A842E3123456/data" → "A842E3123456". Eşleşmezse null. */
export function macFromDataTopic(topic: string): string | null {
  const t = parseUplinkTopic(topic);
  return t?.suffix === "data" ? t.mac : null;
}
