/*
 * Binary paketi Meven:<MAC>/bin'e basar: sahadan yakalanan ya da dokümandaki
 * örnek paketleri backend'e yeniden oynatmak için (lib/binUplink.ts → JSON yolu).
 *
 *   npm run mock:bin <MAC> <hex…>
 *   npm run mock:bin A842E3123456 01 01 01 02 02 03 01 10 00 11 FF 12 00 13 00 14 00 15 FE 16 55 17 64 20 00 C8 03
 *   npm run mock:bin A842E3123456 --ornek d4i      # dokümandaki örnek paket
 *
 * Örnekler: d4i (d4i_periodic, D4i'siz), dali, health, ack, crc (bozuk CRC),
 * alan (tanımsız alan → admin kartında alarm), lora (0x02).
 *
 * Paket gönderilmeden önce yerel olarak çözülür ve sonucu yazdırılır (bozuk
 * paketler de bilerek gönderilebilir). Broker .env.local'dan okunur.
 *
 * ⚠ Canlı broker'a basılan paket backend'de GERÇEK veri gibi işlenir
 * (kayıtlı bir MAC'in lamba/telemetri kaydı yazılır). Yerel olmayan bir
 * MQTT_HOST'ta `--canli` bayrağı olmadan çalışmaz.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { crc16, decodeFrame, parseHex, toHex } from "@/lib/binproto/codec";
import { toLegacy } from "@/lib/binproto/toJson";

const EXAMPLES: Record<string, string> = {
  d4i: "01 01 01 02 02 03 01 10 00 11 FF 12 00 13 00 14 00 15 FE 16 55 17 64 20 00 C8 03",
  dali: "01 01 02 02 03 10 04 11 FF 12 00 13 FF 14 C8 15 FE 16 55 17 55 46 55",
  health: "01 01 05 B0 80 51 01 00 B2 1A 00 01 C0 02 C2 C2 D0 00 5C D1 00 D2 C3 66 E8",
  ack: "01 01 06 A0 02 A1 08 00 A6 F6 A7 03 A8 01 5C 74",
  crc: "01 01 01 02 02 03 01 10 00 11 FF 12 00 13 00 14 00 15 FE 16 55 17 64 20 00 00 00",
  lora: "02 10 20 30 40 50",
};
// Tanımsız alan 0x05 (CRC'si doğru) — "firmware yeni alan ekledi" senaryosu.
{
  const body = Uint8Array.from([0x01, 0x01, 0x01, 0x02, 0x02, 0x05, 0x00]);
  const c = crc16(body);
  EXAMPLES.alan = toHex(Uint8Array.from([...body, c & 0xff, c >> 8]));
}

const args = process.argv.slice(2);
const live = args.includes("--canli");
const exampleIdx = args.indexOf("--ornek");
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ornek") i++; // örnek adını da atla
  else if (!args[i].startsWith("--")) positional.push(args[i]);
}
const mac = (positional[0] ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();

if (mac.length !== 12) {
  console.error("Kullanım: npm run mock:bin <MAC> <hex…> | --ornek <ad> [--canli]");
  console.error(`Örnekler: ${Object.keys(EXAMPLES).join(", ")}`);
  process.exit(2);
}

const hexText = exampleIdx >= 0 ? EXAMPLES[args[exampleIdx + 1] ?? ""] : positional.slice(1).join(" ");
const payload = hexText ? parseHex(hexText) : null;
if (!payload) {
  console.error(exampleIdx >= 0 ? `Bilinmeyen örnek. Seçenekler: ${Object.keys(EXAMPLES).join(", ")}` : "Geçersiz hex.");
  process.exit(2);
}

const host = process.env.MQTT_HOST ?? "";
const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
if (!isLocal && !live) {
  console.error(
    `MQTT_HOST=${host || "(boş)"} yerel değil. Canlı broker'a basılan paket backend'de gerçek veri ` +
      "gibi işlenir. Bilerek yapıyorsan --canli ekle.",
  );
  process.exit(2);
}

// Yerel çözüm — ne gönderdiğimizi görelim.
const frame = decodeFrame(payload);
if (!frame.ok) {
  console.log(`Yerel çözüm: REDDEDİLİR (${frame.reason}: ${frame.detail})`);
} else {
  const r = toLegacy(frame, `Meven:${mac}`, {}, { warnings: [] });
  console.log(`Yerel çözüm: ${frame.typeName ?? frame.type} → ${r ? (r.kind === "hello" ? "hello" : `/${r.suffix} ${JSON.stringify(r.json)}`) : "atlanır"}`);
}

const client = mqtt.connect({
  protocol: "mqtts",
  host,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-bin-${Math.random().toString(16).slice(2, 8)}`,
});
client.on("error", (err) => {
  console.error("MQTT hatası:", err.message);
  process.exit(1);
});
client.on("connect", () => {
  const topic = `Meven:${mac}/bin`;
  client.publish(topic, Buffer.from(payload), { qos: 1 }, (err) => {
    if (err) console.error("Publish hatası:", err.message);
    else console.log(`▶ ${topic} (${payload.length} bayt): ${toHex(payload)}`);
    client.end();
  });
});
