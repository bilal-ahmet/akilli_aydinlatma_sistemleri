/*
 * Komut dinleyicisi — backend'in broker'a GERÇEKTE ne yayınladığını gösterir.
 *
 * "Dashboard şunu gönderiyor" tartışmalarını bitirmek için: cihazın gördüğü
 * ham payload'ı, hangi topic'ten geldiğini ve kontrata uyup uymadığını basar.
 * Salt okunur — hiçbir şey publish etmez, DB'ye dokunmaz.
 *
 * Çalıştır:
 *   npm run watch:cmd              # tüm cmd topic'leri (cihaz + bölge + all)
 *   npm run watch:cmd 1CC3ABF99E18 # yalnızca bu MAC'in topic'i
 *
 * Kullanım: bunu açık bırak, dashboard'dan komutu tetikle, çıktıya bak.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { effectByNumber } from "@/lib/effects";
import { BROADCAST_CHANNEL } from "@/types/lighting";

const ONLY = process.argv[2]?.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
// "+/cmd" tüm Meven:<x>/cmd topic'lerini kapsar (MAC, bölge slug'ı ve "all").
const TOPIC = ONLY ? `Meven:${ONLY}/cmd` : "+/cmd";

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `watch-${Math.random().toString(16).slice(2, 8)}`,
});

client.on("connect", () => {
  client.subscribe(TOPIC, { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`✓ dinleniyor: ${TOPIC}\n  (dashboard'dan komut gönder; Ctrl+C ile çık)\n`);
  });
});

/** Payload'ı kontrata göre denetle — beklenmedik bir şey varsa işaretle. */
function audit(p: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const { action, number, channel, value, text } = p;

  if (action === "efekt") {
    const fx = typeof number === "number" ? effectByNumber(number) : undefined;
    if (!fx) {
      notes.push(`⚠ katalogda olmayan efekt no: ${String(number)}`);
    } else if (fx.allLamps) {
      notes.push(
        "channel" in p
          ? `✗ HATA: "${fx.label}" çok lambalı, channel GÖNDERİLMEMELİ (gelen: ${String(channel)})`
          : `✓ "${fx.label}" çok lambalı → channel yok (doğru)`,
      );
      if (fx.minLamps) notes.push(`  en az ${fx.minLamps} lamba ister`);
    } else {
      notes.push(
        typeof channel === "number"
          ? `✓ "${fx.label}" tek lamba → channel ${channel === BROADCAST_CHANNEL ? "255 (broadcast)" : channel}`
          : `⚠ "${fx.label}" için channel yok — cihaz reddedebilir`,
      );
    }
    if (fx?.needsText) {
      notes.push(text === undefined ? "  text yok → cihaz son metni çalar" : `  text: "${String(text)}"`);
    }
  } else if (action === "dim") {
    if (typeof value !== "number") notes.push("✗ HATA: dim'de value yok");
    if (typeof channel !== "number") notes.push("✗ HATA: dim'de channel yok (cihaz reddeder)");
  } else if (action === "on" || action === "off") {
    if (typeof channel !== "number") notes.push("⚠ on/off'ta channel yok");
  } else {
    notes.push(`⚠ bilinmeyen action: ${String(action)}`);
  }
  return notes;
}

client.on("message", (topic, raw) => {
  const body = raw.toString();
  const stamp = new Date().toLocaleTimeString("tr-TR");
  const target = topic.replace(/^Meven:|\/cmd$/g, "");
  const kind = target === "all" ? "TÜM SİSTEM" : /^[0-9A-F]{12}$/.test(target) ? "cihaz" : "bölge";

  console.log(`[${stamp}] ${kind}: ${target}`);
  console.log(`  ${body}`);
  try {
    for (const n of audit(JSON.parse(body))) console.log(`  ${n}`);
  } catch {
    console.log("  ✗ HATA: geçersiz JSON — cihaz 'gecersiz json' döner");
  }
  console.log();
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
