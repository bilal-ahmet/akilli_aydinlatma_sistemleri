/**
 * MQTT topic şeması (ESP ekibinin kontratı):
 *   Meven:<MAC>/cmd   ← komut (backend publish, cihaz subscribe)
 *   Meven:<MAC>/data  ← veri/durum (cihaz publish, backend subscribe)
 *   Meven:all/cmd     ← toplu komut (tüm cihazlar subscribe)
 *
 * Not: MQTT '+' joker'i bir seviyenin tamamını kapsar; "Meven:" bir seviyenin
 * parçası olduğundan "Meven:+/data" GEÇERSİZdir. Bu yüzden veri aboneliği
 * "+/data" olur; handler MAC'i payload'daki deviceId'den okur.
 */
const PREFIX = "Meven";

export const cmdTopic = (mac: string) => `${PREFIX}:${mac}/cmd`;
export const dataTopic = (mac: string) => `${PREFIX}:${mac}/data`;
export const ALL_CMD = `${PREFIX}:all/cmd`;
export const DATA_WILDCARD = "+/data";

/** "Meven:A842E3123456/data" → "A842E3123456" (yoksa null). MAC topic'ten okunur. */
export function macFromDataTopic(topic: string): string | null {
  if (!topic.startsWith(`${PREFIX}:`) || !topic.endsWith("/data")) return null;
  const mid = topic.slice(PREFIX.length + 1, -"/data".length);
  return mid || null;
}
