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
 *
 * Komutlar binary (protokol v1, ilk bayt 0x01) olmalı: çözülüp denetlenir,
 * hex'i ve kısa id'si (u16) ayrıca yazılır. JSON komut görülürse hata basılır.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { effectByNumber } from "@/lib/effects";
import { MAX_CHANNEL } from "@/types/lighting";
import { decodeFrame, toHex } from "@/lib/binproto/codec";
import { COMMAND_ACTIONS } from "@/lib/binproto/fields";

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

/**
 * Komutun kapsamı: `channel` YOKSA cihazın tüm lambaları, varsa tek lamba.
 * Broadcast için 255 göndermek YASAK — firmware "bilinmeyen action" döner.
 */
function scopeNote(channel: unknown): string {
  if (channel === undefined) return "✓ channel yok → cihazdaki tüm lambalar";
  if (typeof channel !== "number" || !Number.isInteger(channel)) {
    return `✗ HATA: channel sayı değil (${String(channel)})`;
  }
  if (channel < 0 || channel > MAX_CHANNEL) {
    return `✗ HATA: channel ${channel} aralık dışı — 0-${MAX_CHANNEL} olmalı (255 broadcast KALDIRILDI)`;
  }
  return `✓ tek lamba → channel ${channel}`;
}

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
          ? `✓ "${fx.label}" tek lambaya → channel ${channel}`
          : `✓ "${fx.label}" tüm lambalara → channel yok (doğru)`,
      );
    }
    if (fx?.needsText) {
      notes.push(text === undefined ? "  text yok → cihaz son metni çalar" : `  text: "${String(text)}"`);
    }
  } else if (action === "dim") {
    if (typeof value !== "number") notes.push("✗ HATA: dim'de value yok");
    notes.push(scopeNote(channel));
  } else if (action === "on" || action === "off") {
    notes.push(scopeNote(channel));
  } else {
    notes.push(`⚠ bilinmeyen action: ${String(action)}`);
  }
  return notes;
}

/** Binary komutu JSON komut biçimine çevirir (denetim aynı kalsın). */
function binaryToCommand(raw: Buffer): Record<string, unknown> | string {
  const frame = decodeFrame(raw);
  if (!frame.ok) return `✗ HATA: binary paket bozuk (${frame.reason}: ${frame.detail}) — cihaz -15/-16/-17 döner`;
  if (frame.typeName !== "COMMAND") return `✗ HATA: tip COMMAND değil (${frame.typeName ?? frame.type})`;
  const f = new Map(frame.fields);
  const out: Record<string, unknown> = {};
  const action = f.get("COMMAND_ACTION");
  if (action !== undefined) out.action = COMMAND_ACTIONS[action as number] ?? `bilinmeyen(${String(action)})`;
  if (f.has("COMMAND_VALUE")) out.value = f.get("COMMAND_VALUE");
  if (f.has("COMMAND_EFFECT_NUMBER")) out.number = f.get("COMMAND_EFFECT_NUMBER");
  if (f.has("COMMAND_EFFECT_TEXT")) out.text = f.get("COMMAND_EFFECT_TEXT");
  // Binary'de 255 = broadcast, yokluğuyla aynı anlamda.
  const ch = f.get("COMMAND_CHANNEL");
  if (ch !== undefined && ch !== 255) out.channel = ch;
  if (f.has("COMMAND_ID")) out.id = f.get("COMMAND_ID");
  // Bölge komutları: 0xA9 tekrar eder → Map'ten değil paket sırasından.
  const zones = frame.fields.filter(([n]) => n === "COMMAND_ZONE").map(([, v]) => v);
  if (zones.length > 0) out.zones = zones;
  return out;
}

client.on("message", (topic, raw) => {
  const body = raw.toString();
  const stamp = new Date().toLocaleTimeString("tr-TR");
  const target = topic.replace(/^Meven:|\/cmd$/g, "");
  const kind = target === "all" ? "TÜM SİSTEM" : /^[0-9A-F]{12}$/.test(target) ? "cihaz" : "bölge";

  console.log(`[${stamp}] ${kind}: ${target}`);
  if (raw.length > 0 && raw[0] >= 0x01 && raw[0] <= 0x1f) {
    console.log(`  binary (${raw.length} B): ${toHex(raw)}`);
    const cmd = binaryToCommand(raw);
    if (typeof cmd === "string") {
      console.log(`  ${cmd}`);
    } else {
      console.log(`  = ${JSON.stringify(cmd)}`);
      if (cmd.action === "commission" || cmd.action === "ota_check") console.log(`  ✓ bakım komutu`);
      else if (typeof cmd.action === "string" && cmd.action.startsWith("zone_")) {
        console.log(
          kind === "cihaz"
            ? `  ✓ bölge aboneliği komutu`
            : `  ✗ HATA: zone komutu yalnızca Meven:<MAC>/cmd'ye gider — cihaz -21 ile reddeder`,
        );
      } else for (const n of audit(cmd)) console.log(`  ${n}`);
    }
    console.log();
    return;
  }
  // Backend yalnızca binary gönderir; buraya düşen ya başka bir istemcidir
  // (eski backend sürümü, elle mosquitto_pub) ya da bir regresyon.
  console.log(`  ${body}`);
  console.log("  ✗ HATA: binary olmayan komut — backend yalnızca binary protokol v1 gönderir");
  console.log();
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
