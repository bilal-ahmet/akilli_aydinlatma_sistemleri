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
{ "action": "dim", "value": 75, "channel": 255 }
```
```json
{ "action": "on", "channel": 3 }
```
```json
{ "action": "off", "channel": 255 }
```
- `action`: `"on"` | `"off"` | `"dim"` | `"efekt"`
- `value`: 0-100 (yalnız `dim`'de).
- `channel`: DALI adresi **0-63**, ya da **255 = broadcast** (cihazdaki tüm
  lambalar). Backend `channel`'ı **her komutta** gönderir; dashboard'da tek lamba
  seçilmediyse 255 yazılır. (`dim` ve `efekt` firmware'de channel olmadan
  reddedilir.)

### Efekt komutu
```json
{ "action": "efekt", "number": 10, "channel": 255 }
```
- `number`: **1-tabanlı** efekt sıra numarası. Firmware bunu fonksiyon dizisine
  indeks olarak kullanır (`fx[number-1]()` veya `dali_fx_*`).
- `on`/`off`/`dim` komutu gelince efekt durdurulur.
- **Numaralar bitişik değil:** 1-14 ve **22 (Mors)**. 15-21 arası tanımlı olup
  olmadığı bildirilmedi; dashboard kataloğunda yer almıyorlar.

#### Mors efekti (no 22) — `text` alanı
```json
{ "action": "efekt", "number": 22, "text": "MERHABA", "channel": 255 }
```
- `text`: harf, rakam ve boşluk; **en fazla 32 karakter**.
- `text` **gönderilmezse** cihaz son ayarlanan metni tekrar çalar. Backend bu
  yüzden boş metni alan olarak koymaz, alanı payload'dan tamamen çıkarır.
- Dashboard girişi normalize eder: Türkçe harfler ASCII karşılığına düşer
  (Ş→S, Ğ→G, İ→I…), desteklenmeyen karakterler atılır, 32'ye kırpılır.
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
| 22 | dali_fx_mors | `text` alanındaki metni Mors alfabesiyle çalar |

**Çok lambalı efektler:** Chase (#14) tüm hattı birlikte sürer — komuta
`channel` **konmaz** (broadcast 255 dahil), yoksa cihaz
`chase efekti tum lambalari surer, channel gondermeyin` döner. Katalogda
`allLamps: true` ile işaretlidir; backend bu efektlerde `channel` alanını
payload'a hiç koymaz, dashboard tek lamba seçili olsa bile komutu cihazın
tamamına gönderir. Bu efektler asgari lamba sayısı da ister
(`bu efekt en az N lamba ister…`). Aynı anda en fazla **4 kanalda** efekt
çalışabilir.

## 5) Veri payload (giden, data)

`Meven:<MAC>/data` üzerinde **üç ayrı mesaj tipi** akar. Yeni tiplerde payload'da
`deviceId` **yoktur** — backend MAC'i topic'ten okur (`macFromDataTopic`).

### 5.1) Komut yanıtı (her komuttan sonra)
```json
{ "status": "ok" }
{ "status": "error", "error": "bilinmeyen action" }
```

**Hata metinleri (ESP ekibinin tablosu):**

| Mesaj | Sebep | Kod |
|---|---|---|
| `gecersiz json` | Mesaj JSON olarak ayrıştırılamadı | `invalid-json` |
| `action alani yok` | `action` eksik | `missing-action` |
| `action string degil` | `action` tipi yanlış | `invalid-action-type` |
| `bilinmeyen action` | Cihaz bu action'ı tanımıyor | `unknown-action` |
| `dim icin value (0..100) ve channel (0..63 veya 255) gerekli` | `value`/`channel` eksik veya aralık dışı | `dim-args` |
| `efekt icin number (0..14) ve channel (0..63 veya 255) gerekli` | `number` eksik/aralık dışı | `efekt-args` |
| `d4i_read icin channel (0..63) gerekli` | `channel` eksik | `d4i-read-args` |
| `bu channel DALI hattinda bulunamadi` | Hatta olmayan kanal (ör. 12) | `channel-not-found` |
| `chase efekti tum lambalari surer, channel gondermeyin` | Çok lambalı efekte kanal verildi | `effect-no-channel` |
| `bu efekt en az N lamba ister, hatta M lamba var` | Yetersiz lamba | `not-enough-lamps` |
| `efekt baslatilamadi (bos slot yok veya bellek yetersiz)` | 4 kanal efekt sınırı doldu | `effect-slots-full` |

Kod sütunu `src/lib/deviceErrors.ts` kataloğundan gelir: her metin okunur bir
başlık + sebep + ipucuna çevrilir, dashboard bunu gösterir. **Tanınmayan metin
yutulmaz**, olduğu gibi gösterilir — firmware yeni bir hata eklerse görürsünüz.

Hata dashboard'da bildirim olarak çıkar ve cihaz kartında rozet olarak kalır
(`devices.last_error`); sonraki `{"status":"ok"}` yanıtı rozeti temizler.
Payload'da korelasyon alanı olmadığından hata, o cihaza giden **en son bekleyen**
komuta yazılır; o komutun `channel`'ı da bildirime eklenir (kanala özgü
hatalarda hangi lamba olduğunu göstermek için).

### 5.2) D4i periyodik rapor (adres başına, ~30 sn)
```json
{
  "type": "d4i_periodic",
  "address": 1,
  "online": true,
  "status": {
    "status": 4, "control_gear_present": 255, "lamp_failure": null,
    "lamp_power_on": 255, "actual_level": 254, "max_level": 254,
    "physical_min_level": 157, "min_level": 157
  },
  "d4i_supported": true,
  "d4i": {
    "energy": { "value": 9820.154, "unit": "Wh" },
    "power":  { "value": 47.3, "unit": "W" },
    "driver": { "temperature_c": 52, "input_voltage_v": 232, "operating_time_s": 1685203, "…": "arıza sayaçları" },
    "led":    { "voltage_v": 1.7, "current_a": 0.592, "temperature_c": -7, "…": "arıza sayaçları" }
  }
}
```
- `address`: DALI kısa adres (0-63) = dashboard'daki **kanal/lamba**. Her mesaj
  **tek** adresi taşır.
- `actual_level`: 0-254 DALI arc level. Backend yüzdeye **doğrusal** çevirir
  (`level/254×100`) — firmware `dim` değerini de doğrusal ölçeklediği için.
- DALI sorgu yanıtları üç durumlu: `255` (evet), `0` (hayır), `null` (yanıt yok).
- `d4i_supported: false` ise `d4i` bloğu gönderilmez; `status` bloğu yine gelir.
- Raporun tamamı `d4i_telemetry` tablosunda saklanır (ham `d4i` bloğu dahil) ve
  cihaz modalindeki "D4i telemetrisi" panelinde gösterilir.

### 5.3) Eski (ilk kontrat) rapor — hâlâ destekleniyor
```json
{ "deviceId": "A842E3123456", "brightness": 75, "relayStatus": "on",
  "temperature": 42, "rssi": -67, "status": "ok" }
```
- `relayStatus`: `"on"` | `"off"` · `brightness`: 0-100 · `status`: `"ok"` | `"error"`
- Backend bu formatı `deviceId` alanının varlığından tanır; yeni cihazlarda
  kullanılmaz.

## 6) Akış özeti
- Dashboard tek cihaza komut → `Meven:<MAC>/cmd`'e publish.
- Dashboard bölge komutu → `Meven:<slug>/cmd`'e **tek publish** (o bölgedeki her cihaz alır).
- Dashboard "Tüm Sistem" → `Meven:all/cmd`'e tek publish (her cihaz alır).
- Cihaz komutu işler → `{"status":...}` yanıtını `Meven:<MAC>/data`'ya publish →
  backend hatayı dashboard'a bildirim + rozet olarak yansıtır.
- Cihaz durum bildirir → `Meven:<MAC>/data`'ya `d4i_periodic` publish → backend
  MAC'i **topic'ten** çözüp lamba/bölge snapshot'ını ve telemetriyi günceller.
  (Cihazın MAC'i önceden dashboard'dan `devices` tablosuna kayıtlı olmalı; aksi
  halde veri loglanır ama bölgeyle eşleşmez.)

Donanımsız uçtan uca test: `npm run mock:device <MAC> <kanal sayısı> <bölge slug>`
— sanal cihaz bu sözleşmenin tamamını (doğrulama hataları dahil) taklit eder.

## 7) Kütüphaneler / notlar (Arduino)
- **PubSubClient** + **ArduinoJson v7** + `WiFiClientSecure` (ESP32 core'da).
- `client.setBufferSize(512)` (payload 256'yı aşabilir).
- TLS testi için `WiFiClientSecure::setInsecure()`; üretimde kök sertifika (`setCACert`).
- MAC okuma: `WiFi.macAddress()` → `:` karakterlerini sil, büyük harfe çevir.

Bu klasördeki `esp32-fener/esp32-fener.ino` bu sözleşmeyi uygulayan çalışan referanstır.
