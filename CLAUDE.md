# Akıllı Şehir Aydınlatma Sistemi — CLAUDE.md

## Proje Genel Bakış

Şehir genelindeki sokak lambalarını merkezi olarak yönetmek için geliştirilmiş IoT tabanlı aydınlatma kontrol sistemi. Dashboard üzerinden zone bazlı aç/kapa, dim kontrolü ve cihaz durumu izleme yapılabilir.

---

## Mimari

```
Dashboard (Next.js)
    │
    │  REST API (komut gönder, durum oku)
    ▼
Backend (Next.js API Routes / Node.js)
    │                        ▲
    │  MQTT publish           │  MQTT subscribe (status)
    ▼                        │
MQTT Broker (Mosquitto)
    │                        ▲
    │  subscribe (command)    │  publish (status)
    ▼                        │
ESP32 (PubSubClient)
```

**Şu an:** ESP32 WiFi üzerinden MQTT broker'a bağlanıyor.
**İleride:** LoRaWAN mimarisine geçilecek → `ESP32+LoRa → Gateway → Chirpstack → MQTT → Backend`

---

## Tech Stack

| Katman | Teknoloji |
|---|---|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Backend | Next.js API Routes (veya Node.js/Express) |
| Veritabanı | PostgreSQL (Neon veya DigitalOcean Managed) |
| MQTT Broker | Mosquitto |
| ESP32 Kütüphanesi | PubSubClient + ArduinoJson |
| Deploy | DigitalOcean App Platform + ayrı Droplet (Mosquitto) |

---

## MQTT Yapılandırması

### Broker

```
Host: mqtt.{domain}.com
Port: 1883 (plain) / 8883 (TLS)
Auth: username + password
```

### Topic Hiyerarşisi

```
city/lighting/zone/{zoneId}/command       ← Backend publish, ESP32 subscribe
city/lighting/device/{deviceId}/command   ← Cihaz bazlı komut
city/lighting/device/{deviceId}/status    ← ESP32 publish, Backend subscribe
city/lighting/zone/{zoneId}/status        ← Zone aggregate durumu
```

### QoS Seviyeleri

- Komutlar (command): **QoS 1** — en az bir kez iletim garantisi
- Status: **QoS 0** — fire and forget, yüksek frekanslı

---

## Payload Formatları

### Command Payload (Backend → ESP32)

```json
{
  "action": "dim",
  "value": 75,
  "zoneId": "zone-1",
  "deviceId": "esp32-001",
  "requestId": "uuid-v4",
  "timestamp": "2026-06-22T10:00:00Z"
}
```

`action` değerleri: `"on"` | `"off"` | `"dim"`
`value`: 0–100 arası integer (yalnızca dim için kullanılır)

### Status Payload (ESP32 → Backend)

```json
{
  "deviceId": "esp32-001",
  "zoneId": "zone-1",
  "action": "dim",
  "value": 75,
  "status": "ok",
  "rssi": -67,
  "timestamp": "2026-06-22T10:00:01Z"
}
```

`status` değerleri: `"ok"` | `"error"`

> **LoRa Notu:** Payload yapısı kasıtlı olarak minimal tutulmuştur. LoRa'ya geçişte JSON yerine binary encoding kullanılacak ancak action/value/zoneId semantiği değişmeyecek. Transport katmanı değişir, kontrat değişmez.

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

### Dashboard Real-time

Dashboard cihaz durumlarını real-time takip etmek için **WebSocket** veya **SSE** kullanır:

```
WS /api/ws           → Backend'in MQTT'den aldığı status mesajlarını push eder
```

---

## Veritabanı Şeması

### `zones`

```sql
CREATE TABLE zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

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
// lib/mqtt.ts
import mqtt from 'mqtt';

const client = mqtt.connect('mqtt://mqtt.domain.com', {
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
# Veritabanı
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# MQTT
MQTT_HOST=mqtt.domain.com
MQTT_PORT=1883
MQTT_USER=backend-service
MQTT_PASS=****

# Uygulama
NEXT_PUBLIC_WS_URL=wss://api.domain.com/api/ws
```

---

## Önemli Kurallar ve Kararlar

1. **HTTP sadece dashboard ↔ backend arasında** kullanılır. ESP32 HTTP kullanmaz.
2. **ESP32 hiçbir zaman polling yapmaz.** Komutları MQTT subscribe ile alır.
3. **Zone komutu = tek MQTT publish** → o zone'daki tüm cihazlar alır. Her cihaza ayrı istek gönderilmez.
4. **Payload minimal tutulur.** LoRa geçişinde binary encode edilecek, semantik değişmeyecek.
5. **Command tablosunda requestId ile idempotency** sağlanır; aynı komut iki kez uygulanmaz.
6. **Cihaz durumu DB'de son snapshot olarak tutulur.** Dashboard her zaman DB'den okur, MQTT'den değil.
7. **LoRa geçişinde** transport katmanı değişir (Chirpstack → MQTT → Backend), API kontratı aynı kalır.

---

## Klasör Yapısı (Önerilen)

```
/
├── app/
│   ├── api/
│   │   ├── zones/
│   │   │   ├── route.ts                  # GET /api/zones
│   │   │   └── [zoneId]/
│   │   │       ├── command/route.ts      # POST /api/zones/:id/command
│   │   │       └── status/route.ts       # GET /api/zones/:id/status
│   │   ├── devices/
│   │   │   └── [deviceId]/
│   │   │       ├── command/route.ts
│   │   │       └── status/route.ts
│   │   └── ws/route.ts                   # WebSocket
│   └── dashboard/
│       └── page.tsx
├── lib/
│   ├── mqtt.ts                           # MQTT client singleton
│   ├── db.ts                             # PostgreSQL bağlantısı
│   └── websocket.ts                      # WS broadcast
├── types/
│   └── lighting.ts                       # Shared type definitions
└── CLAUDE.md
```

---

## Geliştirme Sırası

1. PostgreSQL şemasını kur (migration)
2. MQTT broker'ı ayağa kaldır (Mosquitto — ayrı Droplet)
3. `lib/mqtt.ts` singleton'ı yaz
4. Zone ve device API route'larını yaz
5. WebSocket endpoint'ini ekle
6. Frontend'i gerçek API'ye bağla
7. ESP32 arkadaşına broker credentials + topic yapısını ver
8. Entegrasyon testi (mock ESP32 ile mosquitto_pub/sub)
