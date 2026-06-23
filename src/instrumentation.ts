/**
 * Next.js açılış hook'u. Uygulama Node runtime'da ayağa kalkarken MQTT
 * bağlantısını başlatır (HiveMQ Cloud'a subscribe). Edge runtime'da çalışmaz.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getMqttClient } = await import("@/lib/mqtt");
    getMqttClient();
  }
}
