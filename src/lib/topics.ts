/**
 * MQTT topic şeması (ESP ekibinin kontratı):
 *   MEVEN:<MAC>/cmd   ← komut (backend publish, cihaz subscribe)
 *   MEVEN:<MAC>/data  ← veri/durum (cihaz publish, backend subscribe)
 *   MEVEN:all/cmd     ← toplu komut (tüm cihazlar subscribe)
 *
 * Not: MQTT '+' joker'i bir seviyenin tamamını kapsar; "MEVEN:" bir seviyenin
 * parçası olduğundan "MEVEN:+/data" GEÇERSİZdir. Bu yüzden veri aboneliği
 * "+/data" olur; handler MAC'i payload'daki deviceId'den okur.
 */
// ESP cihazları "MEVEN:" (tamamı büyük harf) kullanıyor. MQTT topic'leri
// büyük/küçük harfe DUYARLIDIR; cihazın dinlediği case ile birebir aynı olmalı.
const PREFIX = "MEVEN";

export const cmdTopic = (mac: string) => `${PREFIX}:${mac}/cmd`;
export const dataTopic = (mac: string) => `${PREFIX}:${mac}/data`;
export const ALL_CMD = `${PREFIX}:all/cmd`;
export const DATA_WILDCARD = "+/data";

/**
 * "MEVEN:188B0E88A100/data" → "188B0E88A100" (yoksa null). MAC topic'ten okunur.
 * Prefix büyük/küçük harf farkına dayanıklı (MEVEN/Meven/meven).
 */
export function macFromDataTopic(topic: string): string | null {
  const m = topic.match(/^MEVEN:(.+)\/data$/i);
  return m ? m[1] : null;
}
