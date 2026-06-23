# ESP32 Entegrasyon Sözleşmesi — Fener Aydınlatma

ESP32 tarafında çalışan geliştirici için. Backend + dashboard zaten canlıda;
senin görevin: bir MQTT broker'a (HiveMQ Cloud, TLS) bağlanıp **komutları dinlemek**
ve **durumunu yayınlamak**. HTTP yok, polling yok.

## 1) Ne yapacak cihaz
- HiveMQ Cloud'a **TLS / port 8883** ile bağlan.
- Kendi **zone** ve **device** komut topic'lerine subscribe ol.
- Gelen komutu uygula: `on` / `off` / `dim (0–100)` → lambayı/LED'i sür (dim = PWM).
- Her komuttan sonra ve periyodik olarak (~30 sn) **status** yayınla.

## 2) Broker bilgileri
```
Sağlayıcı : HiveMQ Cloud
Host      : <cluster>.s1.eu.hivemq.cloud      (proje sahibi ayrıca verecek)
Port      : 8883  (sadece TLS — 1883 yok)
Username  : <ayrıca güvenli kanaldan>
Password  : <ayrıca güvenli kanaldan>
```
> Kullanıcı adı/şifre bu dokümana yazılmaz; proje sahibinden güvenli kanaldan al.

## 3) Topic yapısı
| Topic | Yön | Açıklama |
|---|---|---|
| `city/lighting/zone/{zoneId}/command`   | **subscribe** | Zone'a giden komut — o zone'daki tüm cihazlar alır |
| `city/lighting/device/{deviceId}/command` | **subscribe** | Sadece bu cihaza giden komut |
| `city/lighting/device/{deviceId}/status`  | **publish**   | Bu cihazın durumu |

**QoS:** komutlara subscribe → QoS 1 · status publish → QoS 0.

## 4) Payload formatları (JSON)

**Gelen komut** (backend → cihaz):
```json
{ "action": "dim", "value": 75, "zoneId": "ataturk-bulvari", "requestId": "...", "timestamp": "..." }
```
- `action`: `"on"` | `"off"` | `"dim"`
- `value`: 0–100 (yalnızca `dim`'de anlamlı)
- `requestId` / `timestamp` / `zoneId` / `deviceId` bilgi amaçlı; cihaz yalnızca `action` + `value`'ya bakar.

**Yayınlanan status** (cihaz → backend):
```json
{ "deviceId": "ataturk-bulvari-001", "zoneId": "ataturk-bulvari",
  "action": "dim", "value": 75, "status": "ok", "rssi": -67, "timestamp": "..." }
```
- `status`: `"ok"` | `"error"`
- `value`: cihazın güncel parlaklığı (kapalıysa 0)
- `rssi` / `timestamp` opsiyonel ama önerilir.

## 5) deviceId / zoneId atama (ÖNEMLİ)
Cihazın `deviceId` ve `zoneId` değerleri **backend veritabanındaki kayıtlarla eşleşmeli**.
Hazır kayıtlar (her zone için): `{zoneId}-001`, `{zoneId}-002`, `{zoneId}-003`.
Örnek: zone `ataturk-bulvari` → cihaz `ataturk-bulvari-001`.

> Yeni/gerçek bir cihaz eklemek istersen proje sahibi `devices` tablosuna kaydını
> ekler (deviceId + bağlı olduğu zone). Kayıtlı olmayan cihazın status'u yine
> loglanır ama zone ile ilişkilendirilemez.

## 6) Hazır başlangıç kodu
Bu klasörde çalışan bir referans sketch var:
- `esp32-fener/esp32-fener.ino` — tam çalışan örnek (bağlan, dinle, uygula, yayınla, heartbeat)
- `esp32-fener/secrets.example.h` — WiFi + MQTT bilgileri şablonu (`secrets.h` olarak kopyala)
- `README.md` — kütüphaneler, board, yükleme ve test adımları

Kütüphaneler: **PubSubClient**, **ArduinoJson v7** (+ `WiFiClientSecure` ESP32 core'da).
PubSubClient buffer'ını büyüt: `setBufferSize(512)` (komut payload'ı 256'yı aşabilir).

## 7) TLS notu
Hızlı saha testi için `WiFiClientSecure::setInsecure()` yeterli (şifre yine TLS ile
şifreli gider). Üretimde kök sertifika ile `setCACert(...)` kullan (HiveMQ Cloud →
Let's Encrypt / ISRG Root X1).

## 8) Test
Backend + dashboard canlıda. Cihazı flash'la, Serial Monitor'de bağlantıyı gör,
sonra dashboard'dan ilgili zone'u aç/kapat/dim yap → LED tepki vermeli ve durum
dashboard'a yansımalı. (Donanımsız doğrulama için projede `npm run mock:device`
sanal cihazı da var.)
