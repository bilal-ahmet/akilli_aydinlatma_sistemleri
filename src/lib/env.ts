import { z } from "zod";

/**
 * Ortam değişkenleri doğrulaması — LAZY. İlk getEnv() çağrısında doğrular ve
 * cache'ler. Top-level'da çalıştırmıyoruz; aksi halde `next build` route
 * modüllerini import ederken (env henüz yokken) patlardı. Runtime'da eksik
 * değişkende net hata fırlatır.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL gerekli"),
  MQTT_HOST: z.string().min(1, "MQTT_HOST gerekli (HiveMQ Cloud cluster URL)"),
  MQTT_PORT: z.coerce.number().int().positive().default(8883),
  MQTT_USER: z.string().min(1, "MQTT_USER gerekli"),
  MQTT_PASS: z.string().min(1, "MQTT_PASS gerekli"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Ortam değişkenleri eksik/geçersiz:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Binary komut gönderimi (protokol v1, downlink). Varsayılan AÇIK: yalnızca
 * binary gönderdiği görülen cihazlara binary gider (lib/binUplink.ts →
 * binCommandCapable). `MQTT_BINARY_COMMANDS=off` (ya da 0/false) → bütün
 * komutlar JSON — sahada sorun çıkarsa kapatma anahtarı. Opsiyonel olduğu için
 * şemada değil: yanlış yazım MQTT'yi düşürmesin.
 */
export function binaryCommandsEnabled(): boolean {
  const v = process.env.MQTT_BINARY_COMMANDS?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/**
 * JSON aynası (firmware ekibinin izlemesi için): çözülen binary uplink'in
 * JSON karşılığı `Meven:<MAC>/json/<data|health|reject>`'e de basılır.
 * Varsayılan KAPALI (broker trafiği). `MQTT_JSON_MIRROR=all` → bütün cihazlar;
 * virgüllü MAC listesi → yalnızca onlar (iki noktalı/noktasız). Topic bilerek
 * `/data` ve `/health` DEĞİL: backend `+/data`, `+/health` dinler, kendi
 * aynasını cihaz mesajı sanıp ikinci kez işlerdi.
 */
export function jsonMirrorEnabled(mac: string): boolean {
  const v = process.env.MQTT_JSON_MIRROR?.trim();
  if (!v || /^(off|0|false|no)$/i.test(v)) return false;
  if (/^(all|on|1|true|yes)$/i.test(v)) return true;
  return v
    .split(",")
    .map((m) => m.replace(/[^0-9a-fA-F]/g, "").toUpperCase())
    .includes(mac);
}
