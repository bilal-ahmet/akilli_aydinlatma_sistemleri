# ESP32 Entegrasyon Sözleşmesi — Fener Aydınlatma (MAC tabanlı)

Backend + dashboard canlıda. Cihaz, MQTT broker'a (HiveMQ Cloud, TLS) bağlanır,
**kendi MAC adresine göre** komut dinler ve veri yayınlar. HTTP yok, polling yok.

## 1) Broker
```
Sağlayıcı : HiveMQ Cloud
Host      : <cluster>.s1.eu.hivemq.cloud   (proje sahibi ayrıca verir)
Port      : 8883  (yalnızca TLS)
Username  : <ayrıca güvenli kanaldan>
Password  : <ayrıca güvenli kanaldan>
```

## 2) Cihaz kimliği = MAC (iki noktasız, büyük harf)
Cihaz açılışta kendi MAC'ini okur ve iki noktaları atar:
```
A8:42:E3:12:34:56   →   A842E3123456
```
Bu değer hem topic'lerde hem data payload'ındaki `deviceId` alanında kullanılır.

## 3) Topic yapısı
| Topic | Yön | Açıklama |
|---|---|---|
| `Meven:<MAC>/cmd` | **subscribe** | Bu cihaza özel komut |
| `Meven:all/cmd`   | **subscribe** | Tüm cihazlara toplu komut |
| `Meven:<MAC>/data`| **publish**   | Bu cihazın durum/veri raporu |

Cihaz açılışta **iki** topic'e subscribe olur: `Meven:<MAC>/cmd` ve `Meven:all/cmd`.
**QoS:** komutlara subscribe → 1 · data publish → 0.

## 4) Komut payload (gelen, cmd)
```json
{ "action": "dim", "value": 75 }
```
```json
{ "action": "on" }
```
```json
{ "action": "off" }
```
- `action`: `"on"` | `"off"` | `"dim"`
- `value`: 0-100 (yalnız `dim`'de). Cihaz sadece bu iki alana bakar.

## 5) Veri payload (giden, data)
```json
{
  "brightness": 75,
  "relayStatus": "on",
  "temperature": 42,
  "rssi": -67,
  "status": "ok"
}
```
- `relayStatus`: `"on"` | `"off"` (röle durumu → dashboard'da bölge açık/kapalı)
- `brightness`: 0-100 · `temperature`: °C · `rssi`: dBm · `status`: `"ok"` | `"error"`
- **MAC topic'te olduğundan payload'a `deviceId` koymana gerek yok** (backend MAC'i `Meven:<MAC>/data` topic'inden okur; göndersen de yoksayar).
- Her komut sonrası ve periyodik (~30 sn) bir kez yayınla (last-seen güncel kalsın).

## 6) Akış özeti
- Dashboard tek cihaza komut → `Meven:<MAC>/cmd`'e publish.
- Dashboard "Tüm Sistem" → `Meven:all/cmd`'e tek publish (her cihaz alır).
- Cihaz durum bildirir → `Meven:<MAC>/data`'ya publish → backend `deviceId`(MAC) ile
  cihazı bulup dashboard'ı günceller. (Cihazın MAC'i önceden dashboard'dan `devices`
  tablosuna kayıtlı olmalı; aksi halde veri loglanır ama bölgeyle eşleşmez.)

## 7) Kütüphaneler / notlar (Arduino)
- **PubSubClient** + **ArduinoJson v7** + `WiFiClientSecure` (ESP32 core'da).
- `client.setBufferSize(512)` (payload 256'yı aşabilir).
- TLS testi için `WiFiClientSecure::setInsecure()`; üretimde kök sertifika (`setCACert`).
- MAC okuma: `WiFi.macAddress()` → `:` karakterlerini sil, büyük harfe çevir.

Bu klasördeki `esp32-fener/esp32-fener.ino` bu sözleşmeyi uygulayan çalışan referanstır.
