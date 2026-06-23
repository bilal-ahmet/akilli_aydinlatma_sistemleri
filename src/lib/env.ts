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
