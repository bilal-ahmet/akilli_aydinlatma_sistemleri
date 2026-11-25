/**
 * MQTT topic şeması (ESP ekibinin kontratı):
 *   Meven:<MAC>/cmd   ← cihaz komutu (backend publish, cihaz subscribe); bölge,
 *                       alt grup ve müşteri "Tüm Sistem"i de cihaz başına buraya
 *   Meven:all/cmd     ← admin'in global komutu (tüm cihazlar subscribe)
 *   Meven:<MAC>/bin   ← binary protokol: cihazın (0x01) ve ağ geçidinin (0x03) TÜM uplink'i
 *   Meven:<MAC>/data, /health ← eski (JSON) firmware; İŞLENMEZ, yalnızca admin kartında görünür
 *   Meven:<GW>/lwt    ← ağ geçidinin bağlantı durumu (retained {"online":…})
 *
 * Cihazlar bölge / alt grup topic'lerini (Meven:<slug>/cmd) DİNLEMEZ
 * (firmware kararı, 2026-11). Bölge komutu bölgedeki her cihazın MAC topic'ine
 * ayrı publish'tir; cihaz listesi bellek içi tenancy index'inden gelir, publish
 * hiçbir sorgu beklemez (lib/mqtt.ts → publishCommand).
 *
 * Not: MQTT '+' joker'i bir seviyenin tamamını kapsar; "Meven:" bir seviyenin
 * parçası olduğundan "Meven:+/bin" GEÇERSİZdir. Bu yüzden abonelik "+/bin"
 * olur; MAC topic'in kendisinden çözülür (parseBinTopic).
 */
const PREFIX = "Meven";

export const cmdTopic = (mac: string) => `${PREFIX}:${mac}/cmd`;
export const ALL_CMD = `${PREFIX}:all/cmd`;
// Eski (JSON) firmware'in uplink topic'leri. Backend JSON KABUL ETMEZ; bunlara
// yalnızca firmware'i güncellenmemiş cihazı admin kartında göstermek için
// abone olur (lib/binUplink.ts → noteRejectedJson).
export const JSON_DATA_WILDCARD = "+/data";
export const JSON_HEALTH_WILDCARD = "+/health";
// Binary protokol v1 (lib/binproto): cihaz TÜM uplink'ini buraya basar.
// Ağ geçitleri (Border Router, paket sürümü 0x03) de TÜM uplink'ini buraya basar.
export const binTopic = (mac: string) => `${PREFIX}:${mac}/bin`;
export const BIN_WILDCARD = "+/bin";
// Ağ geçidinin bağlantı durumu: retained `{"online":true}` bağlanınca, MQTT
// will ile `{"online":false}` bağlantı kopunca (firmware/GATEWAY-ENTEGRASYON.md).
export const lwtTopic = (mac: string) => `${PREFIX}:${mac}/lwt`;
export const LWT_WILDCARD = "+/lwt";

/**
 * QoS kontratı (tek yer). MQTT'de etkin QoS = min(yayınlayanın QoS'u,
 * abonenin QoS'u): backend'in 2 istemesi yalnızca kendi tarafındaki üst
 * sınırdır; uçtan uca 2 için firmware de komut topic'lerine QoS 2 ile abone
 * olmalı ve /bin, /lwt'yi QoS 2 ile basmalıdır.
 *  - CMD_QOS:    backend → cihaz / ağ geçidi (komut, bakım, zone, gateway komutu)
 *  - UPLINK_QOS: cihaz / ağ geçidi → backend (`+/bin`, `+/lwt` aboneliği)
 * Eski JSON topic'leri (yalnızca görünürlük) ve JSON aynası 0'da kalır.
 */
export const CMD_QOS = 2;
export const UPLINK_QOS = 2;

/** Çözülmüş binary paketin iç JSON'unun türü (lib/binproto/toJson). */
export type UplinkSuffix = "data" | "health";

/** "Meven:A842E3123456/bin" → "A842E3123456". Eşleşmezse null. */
export function parseBinTopic(topic: string): string | null {
  const m = /^Meven:([0-9A-Fa-f]{12})\/bin$/.exec(topic);
  return m ? m[1].toUpperCase() : null;
}

/** "Meven:404CCA544698/lwt" → "404CCA544698". Eşleşmezse null. */
export function parseLwtTopic(topic: string): string | null {
  const m = /^Meven:([0-9A-Fa-f]{12})\/lwt$/.exec(topic);
  return m ? m[1].toUpperCase() : null;
}

/**
 * JSON aynası (yalnızca izleme): çözülmüş binary uplink buraya da basılır
 * (`MQTT_JSON_MIRROR`). Üç seviyeli olduğu için backend'in `+/data`,
 * `+/health` aboneliklerine (JSON reddi sayacı) takılmaz. İzlemek için: `+/json/#`.
 */
export function jsonMirrorTopic(mac: string, suffix: "data" | "health" | "reject"): string {
  return `Meven:${mac}/json/${suffix}`;
}

/**
 * "Meven:A842E3123456/data" → { mac: "A842E3123456", suffix: "data" }. Yalnızca
 * reddedilen JSON'u (eski firmware) MAC'e bağlamak için. Eşleşmezse null.
 */
export function parseJsonUplinkTopic(topic: string): { mac: string; suffix: "data" | "health" } | null {
  const m = /^Meven:([0-9A-Fa-f]{12})\/(data|health)$/.exec(topic);
  return m ? { mac: m[1].toUpperCase(), suffix: m[2] as "data" | "health" } : null;
}
