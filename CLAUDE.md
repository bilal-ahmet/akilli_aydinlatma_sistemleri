# Akıllı Şehir Aydınlatma Sistemi — CLAUDE.md

## Proje Genel Bakış

Şehir genelindeki sokak lambalarını merkezi olarak yönetmek için geliştirilmiş IoT tabanlı aydınlatma kontrol sistemi. Dashboard üzerinden zone bazlı aç/kapa, dim kontrolü ve cihaz durumu izleme yapılabilir.

---

## Mimari

```
Dashboard (Next.js, SSE ile canlı)
    │   ▲
    │   │ SSE (status push: /api/events)
    │  REST API (komut gönder, durum oku)
    ▼
Backend (Next.js API Routes — Railway'de kalıcı Node process)
    │                        ▲
    │  MQTT publish (TLS)     │  MQTT subscribe (status, TLS)
    ▼                        │
MQTT Broker (HiveMQ Cloud, 8883/TLS)
    │                        ▲
    │  subscribe (command)    │  publish (status)
    ▼                        │
ESP32 (PubSubClient + WiFiClientSecure)
```

**Şu an:** ESP32 WiFi → HiveMQ Cloud (TLS/8883) → Backend (Railway) → Neon Postgres. Dashboard, MQTT status'larını SSE ile canlı alır.
**İleride:** LoRaWAN mimarisine geçilecek → `ESP32+LoRa → Gateway → Chirpstack → MQTT → Backend`

---

## Tech Stack

| Katman | Teknoloji |
|---|---|
| Frontend | Next.js 16, TypeScript, Tailwind CSS v4 |
| Backend | Next.js API Routes (runtime = nodejs) |
| Veritabanı | PostgreSQL (Neon) + **Drizzle ORM** |
| MQTT Broker | **HiveMQ Cloud** (TLS, port 8883) |
| Real-time | **SSE** (`/api/events`) — in-memory event bus |
| ESP32 Kütüphanesi | PubSubClient + ArduinoJson + WiFiClientSecure |
| Deploy | **Railway** (kalıcı Node sunucu, tek instance) |

> **Gerçekleşen mimari notu:** İlk taslaktan 3 bilinçli sapma var: (1) real-time için WebSocket yerine **SSE**, (2) self-host Mosquitto yerine **HiveMQ Cloud TLS**, (3) `zones` tablosuna `slug` + dashboard snapshot alanları eklendi. Kontrat (topic/payload/action semantiği) korundu. Detay aşağıda.

---

## MQTT Yapılandırması

### Broker

```
Sağlayıcı: HiveMQ Cloud
Host: {cluster-id}.s1.eu.hivemq.cloud
Port: 8883 (yalnızca TLS — plain 1883 desteklenmez)
Auth: username + password
```

Backend `mqtts://` ile bağlanır (`src/lib/mqtt.ts`). ESP32 `WiFiClientSecure` kullanır.

### Topic Hiyerarşisi (MAC tabanlı — ESP ekibi kontratı)

Cihaz kimliği = **MAC adresi, iki noktasız** (örn. `A842E3123456`). Topic'ler bu
MAC'e göre üretilir (`src/lib/topics.ts`).

```
Meven:<MAC>/cmd    ← Backend publish, ESP32 subscribe (cihaz bazlı komut)
Meven:<slug>/cmd   ← Backend publish, o bölgedeki ESP32'ler subscribe (bölge komutu)
Meven:all/cmd      ← Backend publish, TÜM ESP32'ler subscribe (toplu komut)
Meven:<MAC>/data   ← ESP32 publish, Backend subscribe (durum/telemetri)
```

- **Bölge komutu = tek publish** (Kural #3): backend `Meven:<slug>/cmd`'ye bir kez
  yayınlar, cihaz listesini DB'den çözmez. ESP kendi bölge slug'ını firmware'deki
  `ZONE_SLUG`'tan bilir ve o topic'e subscribe olur. "Tüm Sistem" → `Meven:all/cmd`.
- Backend veri aboneliği `+/data` (MQTT `+` joker'i `Meven:` ile aynı seviyeye
  gömülemez); MAC payload'daki `deviceId`'den okunur.
- **Not:** Bölge komutu SADECE `Meven:<slug>/cmd`'ye gider; backend MAC
  topic'lerine ayrıca fanout yapmaz. Bu yüzden tüm cihazlar `ZONE_SLUG` ile
  flash'lanmış olmalı — flash'lanmamış cihaz bölge komutu almaz. (Geçiş
  döneminde geçici MAC fanout'u vardı; tüm cihazlar flash'landığı için
  kaldırıldı — flash'lı cihazlar komutu iki kez alıyordu.)

### QoS Seviyeleri

- Komutlar (cmd): **QoS 1** — en az bir kez iletim garantisi
- Veri (data): **QoS 0** — fire and forget, yüksek frekanslı

---

## Payload Formatları

### Command Payload (Backend → ESP32, `Meven:<MAC>/cmd` veya `Meven:all/cmd`)

```json
{ "action": "dim", "value": 75 }
```

`action` değerleri: `"on"` | `"off"` | `"dim"` | `"efekt"`
`value`: 0–100 arası integer (yalnızca dim için kullanılır)

**Efekt komutu:** `{ "action": "efekt", "number": 10 }` — `number` 1-tabanlı efekt
sıra no (1-14, donmuş katalog `src/lib/effects.ts`). on/off/dim efekti durdurur.
Bölge snapshot'ında `zones.active_fx` olarak optimistic tutulur.

### Data Payload (ESP32 → Backend, `Meven:<MAC>/data`)

```json
{
  "deviceId": "A842E3123456",
  "brightness": 75,
  "relayStatus": "on",
  "temperature": 42,
  "rssi": -67,
  "status": "ok"
}
```

`relayStatus`: `"on"` | `"off"` (bölge açık/kapalı snapshot'ını sürer) · `status`: `"ok"` | `"error"`

> **LoRa Notu:** Payload yapısı kasıtlı olarak minimal tutulmuştur. LoRa'ya geçişte JSON yerine binary encoding kullanılacak ancak action/value/MAC semantiği değişmeyecek. Transport katmanı değişir, kontrat değişmez.

---

## API Endpoint'leri

### Komut Gönderme

```
POST /api/zones/:zoneId/command
POST /api/devices/:deviceId/command

Body:
{
  "action": "dim" | "on" | "off",
  "value": 0-100
}
```

Backend bu endpoint'leri aldığında ilgili MQTT topic'ine publish eder.

### Durum Okuma

```
GET /api/zones/:zoneId/status        → Son bilinen zone durumu (DB'den)
GET /api/devices/:deviceId/status    → Cihaz son durumu
GET /api/zones                       → Tüm zone listesi
GET /api/devices                     → Tüm cihaz listesi
```

### Dashboard Real-time (SSE)

Dashboard cihaz durumlarını real-time takip etmek için **SSE** (Server-Sent Events) kullanır — Next.js App Router'da native çalışır, custom server gerekmez:

```
GET /api/events      → Backend'in MQTT'den aldığı status mesajlarını push eder (text/event-stream)
```

Frontend tarafı: `src/app/_lib/useLiveStatus.ts` (`EventSource`). Backend köprüsü: `src/lib/events.ts` (in-memory EventEmitter). **Bu yüzden backend tek instance çalışmalı** (bkz. Kurallar #8).

---

## Veritabanı Şeması

### `zones`

```sql
CREATE TABLE zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(100) UNIQUE NOT NULL,  -- MQTT topic / API public id (örn. "ataturk-bulvari")
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  -- dashboard snapshot alanları (Kural #6'yı zone seviyesinde sağlar):
  district    VARCHAR(100),
  pole_count  INTEGER NOT NULL DEFAULT 0,
  is_on       BOOLEAN NOT NULL DEFAULT FALSE,
  brightness  INTEGER NOT NULL DEFAULT 0,
  status      VARCHAR(20) NOT NULL DEFAULT 'ok',  -- ok | warning | fault
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

> Gerçek tanımlar Drizzle ile `src/lib/db/schema.ts`'te; migration `drizzle/`. API ve MQTT topic'lerinde zone için `slug` kullanılır (UUID değil).

### `devices`

```sql
CREATE TABLE devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   VARCHAR(100) UNIQUE NOT NULL,  -- ESP32 tanımlayıcısı
  zone_id     UUID REFERENCES zones(id),
  name        VARCHAR(100),
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### `device_status`

```sql
CREATE TABLE device_status (
  id          BIGSERIAL PRIMARY KEY,
  device_id   VARCHAR(100) NOT NULL,
  action      VARCHAR(20),
  value       INTEGER,
  status      VARCHAR(20),
  rssi        INTEGER,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_device_status_device_id ON device_status(device_id);
CREATE INDEX idx_device_status_recorded_at ON device_status(recorded_at DESC);
```

### `commands`

```sql
CREATE TABLE commands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID UNIQUE NOT NULL,
  target_type VARCHAR(20) NOT NULL,  -- 'zone' | 'device'
  target_id   VARCHAR(100) NOT NULL,
  action      VARCHAR(20) NOT NULL,
  value       INTEGER,
  status      VARCHAR(20) DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
```

---

## MQTT — Backend Entegrasyon Örneği

```typescript
// src/lib/mqtt.ts (özet — gerçek dosyada globalThis singleton + Drizzle yazımı var)
import mqtt from 'mqtt';

const client = mqtt.connect({
  protocol: 'mqtts',            // HiveMQ Cloud TLS
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT), // 8883
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
});

client.on('connect', () => {
  // Tüm cihaz status'larını dinle
  client.subscribe('city/lighting/device/+/status', { qos: 0 });
});

client.on('message', (topic, payload) => {
  const data = JSON.parse(payload.toString());
  // DB'ye kaydet, WebSocket üzerinden dashboard'a ilet
});

export async function publishCommand(
  targetType: 'zone' | 'device',
  targetId: string,
  action: 'on' | 'off' | 'dim',
  value?: number
) {
  const topic = `city/lighting/${targetType}/${targetId}/command`;
  const payload = JSON.stringify({
    action,
    value,
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
  client.publish(topic, payload, { qos: 1 });
}
```

---

## Ortam Değişkenleri (.env)

```env
# Veritabanı (Neon — pooled, sslmode=require)
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require

# MQTT (HiveMQ Cloud — TLS)
MQTT_HOST={cluster-id}.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=backend-service
MQTT_PASS=****

# Uygulama (SSE; aynı origin olduğu için varsayılan /api/events)
NEXT_PUBLIC_SSE_URL=/api/events
```

> Lokal geliştirme şablonu için `.env.example`. Gerçek değerler `.env.local`'a (gitignored) yazılır; canlıda Railway **Service Variables**'ta tutulur.

---

## Önemli Kurallar ve Kararlar

1. **HTTP sadece dashboard ↔ backend arasında** kullanılır. ESP32 HTTP kullanmaz.
2. **ESP32 hiçbir zaman polling yapmaz.** Komutları MQTT subscribe ile alır.
3. **Zone komutu = tek MQTT publish** → o zone'daki tüm cihazlar alır. Her cihaza ayrı istek gönderilmez.
4. **Payload minimal tutulur.** LoRa geçişinde binary encode edilecek, semantik değişmeyecek.
5. **Command tablosunda requestId ile idempotency** sağlanır; aynı komut iki kez uygulanmaz.
6. **Cihaz durumu DB'de son snapshot olarak tutulur.** Dashboard her zaman DB'den okur, MQTT'den değil. Zone snapshot'ı `zones` tablosunda; komut publish'inde optimistic güncellenir, cihaz status'u gelince rafine edilir.
7. **LoRa geçişinde** transport katmanı değişir (Chirpstack → MQTT → Backend), API kontratı aynı kalır.
8. **Backend TEK instance çalışır.** MQTT subscribe + SSE köprüsü in-memory event bus'a (`src/lib/events.ts`) dayanır; çoklu instance'ta status olayları farklı process'lere düşer ve canlı güncelleme bozulur. Yatay ölçekleme gerekince çözüm: Redis pub/sub (örn. Upstash).
9. **MQTT/env hatası web sunucusunu düşürmez.** `src/instrumentation.ts` MQTT başlatmayı try/catch ile sarar; broker erişilemese bile dashboard (DB okuması) çalışır.
10. **Publish önce, DB sonra.** Komut yolunda `publishCommand` (senkron, DB'ye dokunmaz) isteği alır almaz MQTT'ye yazar; `commands` INSERT'i, zone snapshot'ı ve SSE `recordCommand`'a taşınıp route'larda `after()` ile arka plana alınır. Sebep: publish DB'nin arkasındayken Neon round-trip'i (+ scale-to-zero uyanması) komutu saniyelerce geciktiriyordu. **Komut yoluna asla `await db...` eklemeyin** — snapshot/log işleri `recordCommand`'a girer. Ödün: zone/device bulunamasa da 202 döner (var olmayan topic'e publish zararsız, `recordCommand` warn'lar).

---

## Klasör Yapısı (Önerilen)

```
/
├── src/
│   ├── instrumentation.ts                # açılışta MQTT başlatma (try/catch)
│   ├── app/
│   │   ├── page.tsx                      # dashboard (DB'den zone okur)
│   │   ├── _components/                  # UI (DashboardClient, ZoneCard, ...)
│   │   ├── _lib/
│   │   │   ├── useLiveStatus.ts          # SSE (EventSource) hook
│   │   │   ├── mockData.ts / types.ts / format.ts
│   │   └── api/
│   │       ├── zones/route.ts            # GET /api/zones
│   │       ├── zones/[zoneId]/command|status/route.ts
│   │       ├── devices/route.ts
│   │       ├── devices/[deviceId]/command|status/route.ts
│   │       └── events/route.ts           # SSE (/api/events)
│   ├── lib/
│   │   ├── mqtt.ts                       # MQTT singleton (TLS) + publishCommand
│   │   ├── events.ts                     # in-memory event bus (MQTT→SSE)
│   │   ├── db/{schema,index,seed}.ts     # Drizzle
│   │   ├── env.ts  adapters.ts  api/respond.ts
│   └── types/lighting.ts                 # payload tipleri + zod kontrat
├── drizzle/                              # migration'lar
├── firmware/esp32-fener/                 # ESP32 Arduino sketch
├── scripts/mock-esp32.md                 # mosquitto_pub/sub test notları
├── docker-compose.yml                    # lokal postgres (opsiyonel)
└── CLAUDE.md
```

---

## Durum (2026-06)

Backend, DB, MQTT, SSE ve frontend entegrasyonu **tamamlandı ve Railway'de canlıda.**

- [x] PostgreSQL şeması (Drizzle migration, Neon)
- [x] MQTT broker (HiveMQ Cloud, TLS) — `src/lib/mqtt.ts` singleton
- [x] Zone/device API route'ları + SSE (`/api/events`)
- [x] Frontend gerçek API'ye bağlandı (komut + canlı durum)
- [x] Mock ESP32 entegrasyon testi (`scripts/mock-esp32.md`)
- [x] Deploy: Railway + Neon (Service Variables ile env)
- [ ] Gerçek ESP32 sahada test (`firmware/esp32-fener/`)
- [ ] (İleride) LoRaWAN geçişi

### Deploy notları (Railway)
- `master`'a push → otomatik deploy (`npm run build` → `npm start`).
- Env değişkenleri Railway **Service Variables**'ta. `.env.local` deploy edilmez.
- **Replica = 1** (Kural #8). DB değişikliğinde lokalden `npm run db:migrate` (DATABASE_URL = Neon).
