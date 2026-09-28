/**
 * Next.js açılış hook'u. Uygulama Node runtime'da ayağa kalkarken MQTT
 * bağlantısını başlatır (HiveMQ Cloud'a subscribe). Edge runtime'da çalışmaz.
 *
 * MQTT/env hatası web sunucusunu ASLA düşürmemeli — try/catch ile yutulur,
 * sadece loglanır. Böylece MQTT yanlış yapılandırılsa bile dashboard (DB
 * okuması) çalışmaya devam eder.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getMqttClient } = await import("@/lib/mqtt");
    getMqttClient();
  } catch (err) {
    console.error("[instrumentation] MQTT başlatılamadı:", err);
  }

  // Kiracı index'ini ısıt: ilk komut/SSE isteği DB'yi beklemesin (Kural #10).
  // Hata sunucuyu düşürmez; index ilk istekte yeniden denenir.
  try {
    const { refreshTenancy } = await import("@/lib/tenancy");
    void refreshTenancy().catch((err) =>
      console.error("[instrumentation] tenancy yüklenemedi:", err),
    );
  } catch (err) {
    console.error("[instrumentation] tenancy başlatılamadı:", err);
  }
}
