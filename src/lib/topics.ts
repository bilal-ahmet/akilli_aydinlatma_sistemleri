/**
 * MQTT topic şeması (ESP ekibinin kontratı):
 *   Meven:<MAC>/cmd   ← tekil komut (backend publish, cihaz subscribe)
 *   Meven:<slug>/cmd  ← bölge komutu (bölgedeki tüm cihazlar subscribe)
 *   Meven:all/cmd     ← toplu komut (tüm cihazlar subscribe)
 *   Meven:<MAC>/data  ← veri/durum (cihaz publish, backend subscribe)
 *
 * Bölge topic'i sayesinde bölge komutu tek publish'tir: backend cihaz listesini
 * DB'den çözmez, publish hiçbir sorgu beklemez. Cihaz kendi bölge slug'ını
 * firmware'deki ZONE_SLUG'tan bilir.
 *
 * Not: MQTT '+' joker'i bir seviyenin tamamını kapsar; "Meven:" bir seviyenin
 * parçası olduğundan "Meven:+/data" GEÇERSİZdir. Bu yüzden veri aboneliği
 * "+/data" olur; handler MAC'i payload'daki deviceId'den okur.
 */
const PREFIX = "Meven";

export const cmdTopic = (mac: string) => `${PREFIX}:${mac}/cmd`;
export const zoneCmdTopic = (slug: string) => `${PREFIX}:${slug}/cmd`;
export const dataTopic = (mac: string) => `${PREFIX}:${mac}/data`;
export const ALL_CMD = `${PREFIX}:all/cmd`;
export const DATA_WILDCARD = "+/data";
