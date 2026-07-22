/*
 * Sanal ESP32 (mock device) — donanımsız test. ESP ekibinin güncel kontratını
 * birebir taklit eder:
 *   - subscribe Meven:<MAC>/cmd , Meven:<ZONE>/cmd , Meven:all/cmd
 *   - gelen { action, value, number, channel } komutunu DOĞRULAR ve sonucu
 *     Meven:<MAC>/data'ya {"status":"ok"} / {"status":"error","error":"..."}
 *     olarak yayınlar (hata metinleri firmware'dekiyle aynı)
 *   - her DALI adresi için periyodik {"type":"d4i_periodic", ...} raporu
 *
 * Çalıştır:
 *   npm run mock:device                              # 2 kanal, MAC A842E3123456
 *   npm run mock:device A8:42:E3:12:34:56            # iki noktalı da olur
 *   npm run mock:device A842E3123456 4               # 4 DALI kanalı (adres 0..3)
 *   npm run mock:device A842E3123456 2 ataturk-bulvari   # bölge topic'ini de dinle
 *
 * Not: adres 0 bilerek `d4i_supported:false` raporlar (sahadaki örnekle aynı) —
 * dashboard'un D4i'siz sürücüyü de doğru gösterdiğini test etmek için.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import mqtt from "mqtt";
import { effectByNumber, EFFECT_MAX_NUMBER, MORSE_TEXT_MAX } from "@/lib/effects";
import { BROADCAST_CHANNEL, MAX_ARC_LEVEL, MAX_CHANNEL } from "@/types/lighting";

const MAC = (process.argv[2] ?? "A842E3123456")
  .replace(/[^0-9a-fA-F]/g, "")
  .toUpperCase();
const CH_COUNT = Math.max(1, Math.min(64, Number(process.argv[3] ?? 2) || 2));
const ZONE_SLUG = process.argv[4];

const T_CMD = `Meven:${MAC}/cmd`;
const T_ALL = "Meven:all/cmd";
const T_DATA = `Meven:${MAC}/data`;
const TOPICS = [T_CMD, T_ALL, ...(ZONE_SLUG ? [`Meven:${ZONE_SLUG}/cmd`] : [])];

/** Kanal durumu — firmware gibi 0-254 DALI arc level tutulur. */
type ChannelState = { level: number; on: boolean; fx: number | null };
const channels = new Map<number, ChannelState>();
for (let i = 0; i < CH_COUNT; i++) channels.set(i, { level: 0, on: false, fx: null });

/** Mors efektinin son ayarlanan metni — komutta `text` yoksa bu tekrar çalınır. */
let morseText = "";

const client = mqtt.connect({
  protocol: "mqtts",
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  rejectUnauthorized: true,
  clientId: `mock-${MAC}-${Math.random().toString(16).slice(2, 8)}`,
});

function ack(error?: string) {
  const payload = error ? { status: "error", error } : { status: "ok" };
  client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
  console.log(error ? `  → ack: HATA "${error}"` : "  → ack: ok");
}

/** Sürücü/LED sayaçlarıyla birlikte tek adresin D4i raporu. */
function publishD4i(address: number) {
  const s = channels.get(address);
  if (!s) return;
  const supported = address !== 0; // adres 0 → D4i'siz sürücü senaryosu

  const payload: Record<string, unknown> = {
    type: "d4i_periodic",
    address,
    online: true,
    status: {
      status: s.on ? 4 : 0, // bit2 = lamba yanıyor
      control_gear_present: 255,
      lamp_failure: null,
      lamp_power_on: s.on ? 255 : 0,
      actual_level: s.on ? s.level : 0,
      max_level: MAX_ARC_LEVEL,
      physical_min_level: 157,
      min_level: 157,
    },
    d4i_supported: supported,
  };

  if (supported) {
    const powerW = s.on ? Math.round((s.level / MAX_ARC_LEVEL) * 473) / 10 : 0;
    payload.d4i = {
      energy: { raw_integer: "9820154", scale_exponent: -3, value: 9820.154, unit: "Wh" },
      power: { raw_integer: Math.round(powerW * 10), scale_exponent: -1, value: powerW, unit: "W" },
      driver: {
        operating_time_s: 1685203,
        startup_count: 85,
        input_voltage_v: 230 + Math.floor(Math.random() * 5),
        mains_frequency_hz: 49,
        power_factor: 1,
        temperature_c: 45 + Math.floor(Math.random() * 10),
        output_current_percent: Math.round((s.level / MAX_ARC_LEVEL) * 100),
        general_failure: 0,
        general_failure_count: 5,
        undervoltage_failure: 0,
        undervoltage_failure_count: 4,
        overvoltage_failure: 0,
        overvoltage_failure_count: 1,
        power_limitation: 0,
        power_limitation_count: 0,
        thermal_derating: 0,
        thermal_derating_count: 0,
        thermal_shutdown: 0,
        thermal_shutdown_count: 0,
      },
      led: {
        startup_count: 11792,
        operating_time_s: 747782,
        voltage_v: 1.7,
        current_a: 0.592,
        general_failure: 0,
        general_failure_count: 253,
        short_circuit: 0,
        short_circuit_count: 6,
        open_circuit: 0,
        open_circuit_count: 253,
        thermal_derating: 0,
        thermal_derating_count: 1,
        thermal_shutdown: 0,
        thermal_shutdown_count: 5,
        temperature_c: 40 + Math.floor(Math.random() * 10),
      },
    };
  }

  client.publish(T_DATA, JSON.stringify(payload), { qos: 0 });
  console.log(
    `  → d4i_periodic ch${address}: ${s.on ? "açık" : "kapalı"} level=${s.on ? s.level : 0}${supported ? "" : " (D4i yok)"}`,
  );
}

/** Firmware sınırı: aynı anda en fazla bu kadar kanalda efekt çalışabilir. */
const EFFECT_SLOTS = 4;

/** Komutun hedeflediği adresler: 255 = broadcast, aksi halde tek adres. */
function targets(channel: number): number[] {
  return channel === BROADCAST_CHANNEL ? [...channels.keys()] : [channel];
}

/** Efekt hedefi: `channel` yoksa (tüm hattı süren efekt) bütün adresler. */
function effectTargets(channel?: number): number[] {
  return channel === undefined ? [...channels.keys()] : targets(channel);
}

/** Komut var olmayan bir DALI adresini hedefliyorsa hata metnini döner. */
function channelMissing(channel: number): boolean {
  return channel !== BROADCAST_CHANNEL && !channels.has(channel);
}

function validChannel(c: unknown): c is number {
  return (
    typeof c === "number" &&
    Number.isInteger(c) &&
    ((c >= 0 && c <= MAX_CHANNEL) || c === BROADCAST_CHANNEL)
  );
}

client.on("connect", () => {
  console.log(`✓ HiveMQ bağlandı — sanal cihaz ${MAC} (${CH_COUNT} kanal)`);
  client.subscribe(TOPICS, { qos: 1 }, (err) => {
    if (err) return console.error("subscribe hatası:", err.message);
    console.log(`  dinleniyor:\n    ${TOPICS.join("\n    ")}`);
    console.log("\nDashboard'dan komut gönder → burada görünecek, yanıtı dashboard'a dönecek.\n");
    for (const ch of channels.keys()) publishD4i(ch);
  });
});

client.on("message", (topic, raw) => {
  let cmd: {
    action?: string;
    value?: number;
    number?: number;
    channel?: number;
    text?: string;
  };
  try {
    cmd = JSON.parse(raw.toString());
  } catch {
    console.warn("◀ geçersiz JSON");
    return ack("gecersiz json");
  }

  const via = topic === T_ALL ? "all" : topic === T_CMD ? "MAC" : "bölge";
  const { action, value, number, channel, text } = cmd;
  if (action === undefined) return ack("action alani yok");
  if (typeof action !== "string") return ack("action string degil");
  const scope = channel === BROADCAST_CHANNEL ? "tüm kanallar" : `ch${channel}`;

  if (action === "on" || action === "off") {
    if (!validChannel(channel)) return ack("bilinmeyen action");
    if (channelMissing(channel)) {
      console.warn(`◀ ${action} reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }
    for (const a of targets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.on = action === "on";
      s.fx = null;
      if (s.on && s.level === 0) s.level = MAX_ARC_LEVEL;
    }
    console.log(`◀ ${action} (${via}, ${scope})`);
    ack();
    for (const a of targets(channel)) publishD4i(a);
    return;
  }

  if (action === "dim") {
    if (typeof value !== "number" || value < 0 || value > 100 || !validChannel(channel)) {
      console.warn(`◀ dim reddedildi (value=${value} channel=${channel})`);
      return ack("dim icin value (0..100) ve channel (0..63 veya 255) gerekli");
    }
    if (channelMissing(channel)) {
      console.warn(`◀ dim reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }
    for (const a of targets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.level = Math.round((value / 100) * MAX_ARC_LEVEL);
      s.on = true;
      s.fx = null;
    }
    console.log(`◀ dim ${value} (${via}, ${scope})`);
    ack();
    for (const a of targets(channel)) publishD4i(a);
    return;
  }

  if (action === "efekt") {
    if (typeof number !== "number" || number < 0 || number > EFFECT_MAX_NUMBER) {
      console.warn(`◀ efekt reddedildi (number=${number})`);
      return ack("efekt icin number (0..14) ve channel (0..63 veya 255) gerekli");
    }

    const fx = effectByNumber(number);

    // Tüm hattı süren efektler (Chase) kanal KABUL ETMEZ ve asgari lamba ister.
    if (fx?.allLamps) {
      if (channel !== undefined) {
        console.warn(`◀ ${fx.label} reddedildi: channel gönderildi (${channel})`);
        return ack("chase efekti tum lambalari surer, channel gondermeyin");
      }
      const min = fx.minLamps ?? 2;
      if (channels.size < min) {
        console.warn(`◀ ${fx.label} reddedildi: ${channels.size} lamba yetersiz`);
        return ack(`bu efekt en az ${min} lamba ister, hatta ${channels.size} lamba var`);
      }
    } else if (!validChannel(channel)) {
      console.warn(`◀ efekt reddedildi (channel=${channel})`);
      return ack("efekt icin number (0..14) ve channel (0..63 veya 255) gerekli");
    }

    // Hattaki gerçek adres mi? (broadcast hariç)
    if (channel !== undefined && channelMissing(channel)) {
      console.warn(`◀ efekt reddedildi: ch${channel} hatta yok`);
      return ack("bu channel DALI hattinda bulunamadi");
    }

    // Aynı anda en fazla 4 kanalda efekt çalışabilir (firmware slot sınırı).
    const wouldRun = new Set([...channels.entries()].filter(([, s]) => s.fx).map(([a]) => a));
    if (number > 0) for (const a of effectTargets(channel)) wouldRun.add(a);
    if (wouldRun.size > EFFECT_SLOTS) {
      console.warn(`◀ efekt reddedildi: slot dolu (${wouldRun.size}/${EFFECT_SLOTS})`);
      return ack("efekt baslatilamadi (bos slot yok veya bellek yetersiz)");
    }

    // Mors: `text` opsiyonel — gelmezse son ayarlanan metin çalınır.
    if (fx?.needsText && text !== undefined) {
      if (typeof text !== "string" || text.length > MORSE_TEXT_MAX || !/^[A-Z0-9 ]*$/.test(text)) {
        console.warn(`◀ mors metni reddedildi: ${JSON.stringify(text)}`);
        return ack("mors icin text (harf/rakam/bosluk, en fazla 32 karakter) gerekli");
      }
      morseText = text;
    }
    for (const a of effectTargets(channel)) {
      const s = channels.get(a);
      if (!s) continue;
      s.fx = number === 0 ? null : number;
      if (number > 0) s.on = true;
    }
    const suffix = fx?.needsText ? ` "${morseText || "(metin ayarlanmadı)"}"` : "";
    console.log(`◀ efekt #${number} ${fx?.label ?? "durdur"}${suffix} (${via}, ${scope})`);
    ack();
    for (const a of effectTargets(channel)) publishD4i(a);
    return;
  }

  if (action === "d4i_read") {
    if (typeof channel !== "number" || channel < 0 || channel > MAX_CHANNEL) {
      console.warn(`◀ d4i_read reddedildi (channel=${channel})`);
      return ack("d4i_read icin channel (0..63) gerekli");
    }
    console.log(`◀ d4i_read (${via}, ch${channel})`);
    ack();
    publishD4i(channel);
    return;
  }

  console.warn(`◀ bilinmeyen action: ${action}`);
  ack("bilinmeyen action");
});

client.on("error", (e) => console.error("MQTT hata:", e.message));

// Periyodik rapor — her adres için sırayla.
setInterval(() => {
  for (const ch of channels.keys()) publishD4i(ch);
}, 30000);

process.on("SIGINT", () => {
  console.log("\nkapatılıyor…");
  client.end(() => process.exit(0));
});
