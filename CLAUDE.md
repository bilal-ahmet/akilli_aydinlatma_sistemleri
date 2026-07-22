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
{ "action": "dim", "value": 75, "channel": 3 }
```

`action` değerleri: `"on"` | `"off"` | `"dim"` | `"efekt"`
`value`: 0–100 arası integer (yalnızca dim için kullanılır)
`channel`: hedef **DALI kanalı (lamba)** — 0–63, ya da **255 = broadcast**
(cihazdaki tüm lambalar). Bir ESP'ye birden çok bağımsız aydınlatma bağlanabilir;
her biri bu kanal no ile ayrı sürülür.

> **`channel` her komutta gönderilir.** Firmware `dim` ve `efekt`'i channel'sız
> reddeder (`"dim icin value (0..100) ve channel (0..63 veya 255) gerekli"`). API
> kontratında `channel` yokluğu hâlâ "tüm cihaz" demektir; 255'e çeviri yalnızca
> `buildPayload`'da yapılır (`BROADCAST_CHANNEL`).

**Efekt komutu:** `{ "action": "efekt", "number": 10, "channel": 255 }` — `number`
1-tabanlı efekt sıra no, donmuş katalog `src/lib/effects.ts`. `channel` ile tek
lambaya da verilebilir. on/off/dim efekti durdurur. Bölge snapshot'ında
`zones.active_fx`, lamba snapshot'ında `fixtures.active_fx` olarak optimistic
tutulur.

Katalog **iki aileye** ayrılır (tam tablo: `firmware/ESP32-ENTEGRASYON.md` §4):

- **Tek lamba (1-13, 15-22)** — `channel` ile tek DALI adresine verilebilir.
- **Çok lambalı (14, 23-28)** — hattın tamamını birlikte sürer, **`channel`
  KABUL ETMEZ** ve `minLamps` kadar lamba ister.

> Doğrulama sınırı `EFFECT_MAX_NUMBER` (katalogun en büyük numarası),
> **`EFFECT_COUNT` değil**. Şu an ikisi de 28, ama bir numara atlanırsa yalnızca
> ilki doğru kalır — katalog dizisi de numara sırasında değil, aileye göre gruplu.

**Çok lambalı efektler (`allLamps` + `minLamps`)**: `buildPayload` bu efektlerde
`channel` alanını hiç koymaz (broadcast 255 bile hata döndürür),
`DeviceControlModal` tek lamba seçili olsa da komutu cihazın tamamına gönderir,
`EffectPicker` lambası yetmeyen efektleri pasif gösterir (`lampCount` yalnızca
tek cihaz hedefinde bilinir; bölge/"tüm sistem"de efekt sunulur, yetersiz cihaz
kendi hatasını döner). Cihaz ayrıca aynı anda en fazla 4 kanalda efekt çalıştırır
— dolduğunda `efekt baslatilamadi (bos slot yok…)` döner.

**Mors efekti (no 22):** ek `text` alanı alır —
`{ "action": "efekt", "number": 22, "text": "MERHABA", "channel": 255 }`.
Harf, rakam ve boşluk; en fazla 32 karakter (`MORSE_TEXT_MAX`). `text`
gönderilmezse cihaz **son ayarlanan metni** tekrar çalar; bu yüzden boş string
gönderilmez, alan payload'a hiç konmaz. Girdi `normalizeMorseText` ile indirgenir
(Türkçe harfler ASCII'ye: Ş→S, desteklenmeyen karakterler atılır) — hem
dashboard'da anlık, hem `commandRequestSchema`'da sunucu tarafında.

### Data Payload (ESP32 → Backend, `Meven:<MAC>/data`)

Bu topic'te **üç kontrat** akar; ayrım `src/types/lighting.ts` → `parseUplink`
içinde yapılır. Yeni iki formatta payload'da `deviceId` **yoktur** — MAC
topic'ten çözülür (`macFromDataTopic`).

**1. Komut yanıtı** — cihaz her komuttan sonra sonucu yayınlar:

```json
{ "status": "ok" }
{ "status": "error", "error": "bilinmeyen action" }
```

Hata metni SSE ile dashboard'a gider: sağ altta bildirim + cihaz kartında rozet
(`devices.last_error`, sonraki `ok` yanıtında temizlenir). En son bekleyen komut
`commands.status='failed'` olur ve o komutun `channel`'ı olaya eklenir (yanıt
kanal taşımıyor; kanala özgü hatalarda hangi lamba olduğunu göstermek için).

Ham metinler `src/lib/deviceErrors.ts` kataloğunda okunur başlık + sebep +
ipucuna çevrilir (`describeDeviceError`); UI ham metin yerine bunu gösterir.
Sayı taşıyan metinler (`bu efekt en az N lamba ister…`, efekt aralığı) regex ile
eşleşir, böylece firmware sınırları değişince katalog bozulmaz. **Tanınmayan
metin yutulmaz**, `known:false` ile ham haliyle gösterilir. Tam tablo:
`firmware/ESP32-ENTEGRASYON.md` §5.1.

**2. D4i periyodik rapor** — DALI adresi (lamba) başına bir mesaj:

```json
{
  "type": "d4i_periodic", "address": 1, "online": true,
  "status": { "status": 4, "lamp_power_on": 255, "actual_level": 254,
              "max_level": 254, "min_level": 157, "lamp_failure": null },
  "d4i_supported": true,
  "d4i": { "energy": {...}, "power": {...}, "driver": {...}, "led": {...} }
}
```

- `address` → `fixtures.channel`. Her mesaj **tek** adres taşır; bölge/cihaz
  agregatı bu yüzden tek mesajdan değil, cihazın tüm `fixtures` satırlarından
  türetilir.
- `actual_level` 0–254 DALI arc level → yüzdeye **doğrusal** çevrilir
  (`levelToPercent`, tek dönüşüm noktası).
- DALI sorgu yanıtları üç durumlu: `255` evet, `0` hayır, `null` yanıt yok
  (`flagToBool`).
- Raporun tamamı `d4i_telemetry`'ye yazılır (ham `d4i` bloğu `raw` JSONB'de);
  cihaz modalindeki "D4i telemetrisi" paneli `GET /api/devices/:id/telemetry`
  ile bunu okur.

**3. Eski rapor (geriye uyum)** — `deviceId` alanı olan ilk kontrat:

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

Çok-lamba (DALI kanalları) — her lamba `channels[]` içinde kanal başına raporlanır:

```json
{
  "deviceId": "A842E3123456",
  "temperature": 42, "rssi": -67, "status": "ok",
  "channels": [
    { "ch": 0, "brightness": 45, "relayStatus": "on" },
    { "ch": 1, "brightness": 80, "relayStatus": "on" },
    { "ch": 2, "brightness": 0,  "relayStatus": "off" }
  ]
}
```

`relayStatus`: `"on"` | `"off"` · `status`: `"ok"` | `"error"`. `channels` gelince her
kanal `fixtures` tablosuna upsert edilir; bölge snapshot'ı kanallardan türetilen
cihaz-seviyesi agregatla (açık kanal varsa `isOn`, parlaklık açık kanal ortalaması)
rafine edilir. `channels` yoksa mevcut tek-lamba davranışı korunur.

> **LoRa Notu:** Payload yapısı kasıtlı olarak minimal tutulmuştur. LoRa'ya geçişte JSON yerine binary encoding kullanılacak ancak action/value/MAC semantiği değişmeyecek. Transport katmanı değişir, kontrat değişmez.

---

## API Endpoint'leri

### Komut Gönderme

```
POST /api/zones/:zoneId/command
POST /api/devices/:deviceId/command       # channel ile tek lamba, yoksa tüm cihaz
POST /api/command/all                     # Meven:all/cmd (toplu)

Body:
{
  "action": "dim" | "on" | "off" | "efekt",
  "value": 0-100,          # dim için
  "number": 1-14 | 22,     # efekt için (katalog: src/lib/effects.ts)
  "text": "MERHABA",       # (opsiyonel) yalnızca Mors efektinde (no 22), ≤32 karakter
  "channel": 0-63          # (opsiyonel) tek DALI kanalı (lamba); cihaz komutunda
}
```

Backend bu endpoint'leri aldığında ilgili MQTT topic'ine publish eder.

**Cihaz yönetimi:**

```
POST   /api/devices              → cihaz ekle { mac, zoneSlug, name? }
PATCH  /api/devices/:deviceId    → bölge / isim güncelle { zoneSlug?, name? }
DELETE /api/devices/:deviceId    → cihazı ve tüm kayıtlarını sil
```

> **Bölge değişikliği yalnızca dashboard kaydını taşır.** Cihazın hangi
> `Meven:<slug>/cmd` topic'ini dinlediği firmware'deki `ZONE_SLUG`'tan gelir
> (Kural #3); cihaz yeniden flaşlanana kadar **eski** bölgenin toplu komutlarını
> almaya devam eder, yeninin komutlarını almaz. Tekil (MAC) ve `Meven:all/cmd`
> komutları etkilenmez. Dashboard bölge seçimi değiştiğinde bu uyarıyı gösterir.
> MAC değiştirilemez: cihazın kimliği odur, tüm telemetri/lamba kayıtları ona bağlı.

**Lamba (DALI kanal) yönetimi:**

```
GET    /api/devices/:deviceId/fixtures          → cihaza bağlı lambalar
POST   /api/devices/:deviceId/fixtures          → manuel lamba ekle { channel, name? }
DELETE /api/devices/:deviceId/fixtures/:channel → lamba kaydını sil
GET    /api/devices/:deviceId/telemetry         → kanal başına son D4i raporu
```

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
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     VARCHAR(100) UNIQUE NOT NULL,  -- ESP32 tanımlayıcısı (MAC)
  zone_id       UUID REFERENCES zones(id),
  name          VARCHAR(100),
  last_seen     TIMESTAMPTZ,
  last_error    VARCHAR(200),   -- son komut yanıtı hatası (ok gelince NULL'lanır)
  last_error_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### `fixtures`

Bir ESP'ye (cihaza) bağlı tek bağımsız aydınlatma = DALI kanalı. Bir cihazda
birden çok lamba olabilir; her biri `channel` (0-63) ile adreslenir ve bağımsız
kontrol edilir. Cihaz verisinden (`channels[]`) otomatik upsert edilir; dashboard'dan
manuel de eklenebilir.

```sql
CREATE TABLE fixtures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   VARCHAR(100) NOT NULL,          -- MAC (devices.device_id'ye mantıksal ref)
  channel     INTEGER NOT NULL,               -- DALI kanal (lamba) no, 0-63
  name        VARCHAR(100),
  brightness  INTEGER NOT NULL DEFAULT 0,
  is_on       BOOLEAN NOT NULL DEFAULT FALSE,
  active_fx   INTEGER,                         -- aktif efekt (1-14, null = yok)
  status      VARCHAR(20) NOT NULL DEFAULT 'ok',
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, channel)
);
CREATE INDEX idx_fixtures_device_id ON fixtures(device_id);
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

### `d4i_telemetry`

`d4i_periodic` raporlarının append-only geçmişi — DALI adresi başına bir satır.
Sık okunan büyüklükler ayrı sütunda, raporun ham `d4i` bloğu (sürücü/LED arıza
sayaçları dahil) `raw` JSONB'de.

```sql
CREATE TABLE d4i_telemetry (
  id            BIGSERIAL PRIMARY KEY,
  device_id     VARCHAR(100) NOT NULL,   -- MAC (topic'ten)
  channel       INTEGER NOT NULL,        -- payload'daki `address`
  online        BOOLEAN,
  d4i_supported BOOLEAN NOT NULL DEFAULT FALSE,
  status_byte   INTEGER,  actual_level INTEGER,      -- 0-254 arc level
  min_level     INTEGER,  max_level    INTEGER,  physical_min_level INTEGER,
  lamp_failure  BOOLEAN,  lamp_power_on BOOLEAN, control_gear_present BOOLEAN,
  energy_wh     DOUBLE PRECISION, power_w DOUBLE PRECISION,
  driver_temperature_c INTEGER, driver_voltage_v INTEGER, driver_operating_time_s INTEGER,
  led_temperature_c INTEGER, led_voltage_v DOUBLE PRECISION, led_current_a DOUBLE PRECISION,
  raw           JSONB,                   -- `d4i` bloğunun tamamı
  recorded_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_d4i_telemetry_device_channel ON d4i_telemetry(device_id, channel);
CREATE INDEX idx_d4i_telemetry_recorded_at ON d4i_telemetry(recorded_at DESC);
```

> Cihaz kanal başına ~30 sn'de bir yayın yapar; tablo sınırsız büyür. İleride
> saklama politikası (örn. 90 günden eskiyi sil) gerekecek.

### `commands`

```sql
CREATE TABLE commands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID UNIQUE NOT NULL,
  target_type VARCHAR(20) NOT NULL,  -- 'zone' | 'device'
  target_id   VARCHAR(100) NOT NULL,
  channel     INTEGER,               -- hedef DALI kanal (lamba) no; NULL = tüm cihaz
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
│   │   │   ├── ErrorToasts.tsx           # cihaz komut hatası bildirimleri (SSE)
│   │   │   ├── D4iPanel.tsx              # sürücü/LED telemetri detayı
│   │   ├── _lib/
│   │   │   ├── useLiveStatus.ts          # SSE (EventSource) hook
│   │   │   ├── mockData.ts / types.ts / format.ts
│   │   └── api/
│   │       ├── zones/route.ts            # GET /api/zones
│   │       ├── zones/[zoneId]/command|status/route.ts
│   │       ├── devices/route.ts
│   │       ├── devices/[deviceId]/command|status|fixtures|telemetry/route.ts
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
