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
| `Meven:<MAC>/cmd`  | **subscribe** | Bu cihaza özel komut |
| `Meven:<slug>/cmd` | **subscribe** | Cihazın bölgesine toplu komut |
| `Meven:all/cmd`    | **subscribe** | Tüm cihazlara toplu komut |
| `Meven:<MAC>/data` | **publish**   | Bu cihazın durum/veri raporu |

Cihaz açılışta **üç** topic'e subscribe olur: `Meven:<MAC>/cmd`,
`Meven:<ZONE_SLUG>/cmd` ve `Meven:all/cmd`.
**QoS:** komutlara subscribe → 1 · data publish → 0.

### ZONE_SLUG provisioning (cihaz başına, zorunlu)
`secrets.h` içine cihazın bulunduğu bölgenin slug'ı yazılır:
```c
#define ZONE_SLUG  "ataturk-bulvari"
```
Bu değer dashboard'daki bölge slug'ı (`zones.slug`) ile **birebir** aynı olmalı —
`GET /api/zones` yanıtındaki `id` alanından okunabilir. Yanlış yazılırsa cihaz
bölge komutlarını almaz (tekil ve toplu komutlar çalışmaya devam eder).
Serial'da `[mqtt] subscribe: … , Meven:<slug>/cmd , …` satırıyla doğrula.

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
- `action`: `"on"` | `"off"` | `"dim"` | `"efekt"`
- `value`: 0-100 (yalnız `dim`'de).

### Efekt komutu
```json
{ "action": "efekt", "number": 10 }
```
- `number`: **1-tabanlı** efekt sıra numarası (1-14). Firmware bunu fonksiyon
  dizisine indeks olarak kullanır (`fx[number-1]()` veya `dali_fx_*`).
- `on`/`off`/`dim` komutu gelince efekt durdurulur.
- **Numara tablosu (DONMUŞ KONTRAT — sıra değişmez):**

| # | Fonksiyon | Açıklama |
|---|-----------|----------|
| 1 | dali_fx_fade | Breathe / Fade — yavaş açılıp kapanma |
| 2 | dali_fx_blink | Tam aç/kapa ~0.5 sn |
| 3 | dali_fx_strobe | Kısa parlak flaşlar |
| 4 | dali_fx_random | Rastgele parlaklık (titreme) |
| 5 | dali_fx_steps | Çeyrek seviyelerde duraklama |
| 6 | dali_fx_pulse | Sinüs eğrili nefes |
| 7 | dali_fx_heartbeat | İki hızlı vuruş + dinlenme |
| 8 | dali_fx_candle | Mum gibi düzensiz titreşim |
| 9 | dali_fx_sos | Mors SOS (... --- ...) |
| 10 | dali_fx_police | Üçlü hızlı flaş |
| 11 | dali_fx_twinkle | Loş zemin + parıltılar |
| 12 | dali_fx_lightning | Karanlık + ani şimşek |
| 13 | dali_fx_disco | Rastgele efekt zinciri |
| 14 | dali_fx_chase | Lambaları sırayla yakma (0..count-1) |

## 5) Veri payload (giden, data)
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
- `relayStatus`: `"on"` | `"off"` (röle durumu → dashboard'da bölge açık/kapalı)
- `brightness`: 0-100 · `temperature`: °C · `rssi`: dBm · `status`: `"ok"` | `"error"`
- Her komut sonrası ve periyodik (~30 sn) bir kez yayınla (last-seen güncel kalsın).

## 6) Akış özeti
- Dashboard tek cihaza komut → `Meven:<MAC>/cmd`'e publish.
- Dashboard bölge komutu → `Meven:<slug>/cmd`'e **tek publish** (o bölgedeki her cihaz alır).
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
