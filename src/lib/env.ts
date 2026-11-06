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
