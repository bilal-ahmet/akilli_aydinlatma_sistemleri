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

> **Cihaz başka bir bölgeye taşınırsa yeniden flaşlanmalıdır.** Dashboard'dan
> bölge değiştirmek (`PATCH /api/devices/:mac`) yalnızca kaydı taşır; cihaz
> `ZONE_SLUG` güncellenene kadar eski bölgenin komutlarını dinlemeye devam eder.
> Dashboard bu durumu bölge seçimi değiştiğinde uyarı olarak gösterir.

## 4) Komut payload (gelen, cmd)

Tek lamba (DALI adresi 3):
```json
{ "action": "on", "channel": 3 }
```
Cihazdaki **tüm lambalar** — `channel` alanı hiç yok:
```json
{ "action": "dim", "value": 75 }
```
```json
{ "action": "off" }
```
- `action`: `"on"` | `"off"` | `"dim"` | `"efekt"`
- `value`: 0-100 (yalnız `dim`'de).
- `channel`: DALI adresi **0-63**. **Alan yoksa komut cihazdaki tüm lambalara
  uygulanır.**

> **⚠ Broadcast 255 KALDIRILDI.** Eskiden "tüm lambalar" için `"channel": 255`
> gönderiliyordu; firmware bunu artık kabul etmiyor ve `bilinmeyen action`
> döndürüyor. Toplu komutlarda (tüm cihaz / bölge / tüm sistem) backend artık
> `channel` alanını payload'a **hiç koymuyor** (`buildPayload`, src/lib/mqtt.ts).

### Efekt komutu
```json
{ "action": "efekt", "number": 10 }
```
(tek lambaya verilecekse ek olarak `"channel": 3`)
- `number`: **1-tabanlı** efekt sıra numarası. Firmware bunu fonksiyon dizisine
  indeks olarak kullanır (`fx[number-1]()` veya `dali_fx_*`).
- `on`/`off`/`dim` komutu gelince efekt durdurulur.
- **Aralık: 1-28** (kesintisiz). İki aile var — tek lamba ve çok lambalı; bkz.
  aşağıdaki tablolar. `0` efekti durdurur.

#### Mors efekti (no 22) — `text` alanı
```json
{ "action": "efekt", "number": 22, "text": "MERHABA" }
```
- `text`: harf, rakam ve boşluk; **en fazla 32 karakter**.
- `text` **gönderilmezse** cihaz son ayarlanan metni tekrar çalar. Backend bu
  yüzden boş metni alan olarak koymaz, alanı payload'dan tamamen çıkarır.
- Dashboard girişi normalize eder: Türkçe harfler ASCII karşılığına düşer
  (Ş→S, Ğ→G, İ→I…), desteklenmeyen karakterler atılır, 32'ye kırpılır.
- **Numara tablosu (DONMUŞ KONTRAT — numaralar değişmez):**

**Tek lamba efektleri** — `channel` ile tek DALI adresine verilebilir:

| # | Fonksiyon | Açıklama |
|---|-----------|----------|
| 1 | dali_fx_fade | Fade — yavaş açılıp kapanma |
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
| 15 | — | Nefes |
| 16 | — | Deniz feneri |
| 17 | — | Gün doğumu |
| 18 | — | Alarm |
| 19 | — | Sekme |
| 20 | — | Rastgele yürüyüş |
| 21 | — | Hızlanan |
| 22 | dali_fx_mors | Mors — `text` alanındaki metni çalar |

**Çok lambalı efektler** — hattın tamamını birlikte sürerler, `channel`
**KABUL ETMEZLER** ve asgari lamba sayısı isterler:

| # | Ad | Min. lamba |
|---|-----|---|
| 14 | Chase | 2 |
| 23 | Karşılıklı | 2 |
| 24 | Dalga | 2 |
| 25 | Meteor | 3 |
| 26 | PingPong | 3 |
| 27 | Doldur | 2 |
| 28 | Rastgele lamba | 2 |

Bu efektlerde komuta `channel` **konmaz**, yoksa cihaz
`chase efekti tum lambalari surer, channel gondermeyin` döner. Katalogda
`allLamps: true` + `minLamps` ile işaretlidirler; backend `channel` alanını
payload'a hiç koymaz, dashboard tek lamba seçili olsa bile komutu cihazın
tamamına gönderir ve lambası yetmeyen efektleri baştan pasif gösterir.
Aynı anda en fazla **4 kanalda** efekt çalışabilir.

> 15-21 ve 23-28 için firmware fonksiyon adları bildirilmedi (tabloda `—`);
> `src/lib/effects.ts`'teki açıklamaları da addan çıkarıldı. Efektin gerçek
> davranışı farklıysa yalnızca açıklama düzeltilir, numara sabit kalır.

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
| `bilinmeyen action` | Cihaz bu action'ı tanımıyor — **kaldırılmış `"channel": 255` gönderildiğinde de bu döner** | `unknown-action` |
| `dim icin value (0..100) ve channel (0..63) gerekli` | `value` eksik ya da `channel` aralık dışı | `dim-args` |
| `efekt icin number (0..14) ve channel (0..63) gerekli` | `number` eksik/aralık dışı | `efekt-args` |
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
    "energy": { "value": 9971.068, "unit": "Wh" },
    "power":  { "value": 47.4, "unit": "W" },
    "load_power": { "value": 39, "unit": "W" },
    "driver": { "temperature_c": 54, "input_voltage_v": 229, "operating_time_s": 1712344,
                "output_current_percent": 85, "startup_count": 87, "…": "arıza sayaçları" },
    "led":    { "voltage_v": null, "voltage_reported_v": 1.8, "voltage_estimated_v": 65.878,
                "…": "ölçüm doğrulama + arıza sayaçları" },
    "bank_206_raw_hex": "2000FF01…", "sample_coherent": true, "sample_state": "on"
  }
}
```
- `address`: DALI kısa adres (0-63) = dashboard'daki **kanal/lamba**. Her mesaj
  **tek** adresi taşır.
- `actual_level`: 0-254 DALI arc level. Backend yüzdeye **doğrusal** çevirir
  (`level/254×100`) — firmware `dim` değerini de doğrusal ölçeklediği için.
- DALI sorgu yanıtları üç durumlu: `255` (evet), `0` (hayır), `null` (yanıt yok).
- `d4i_supported: false` ise `d4i` bloğu gönderilmez; `status` bloğu yine gelir.
- `power` şebekeden **çekilen**, `load_power` LED'e giden **yük** gücüdür.
- Raporun tamamı `d4i_telemetry` tablosunda saklanır (ham `d4i` bloğu dahil) ve
  cihaz modalindeki "D4i telemetrisi" panelinde gösterilir.

#### Ölçüm doğrulama (LED bloğu)

Sürücü güvenmediği ölçümü `null`'a çeker; yanına ham ve — hesaplayabiliyorsa —
tahmini değeri koyar:

| Alan | Anlamı | Dashboard |
|---|---|---|
| `voltage_v` / `current_a` / `temperature_c` | **doğrulanmış** değer (yoksa `null`) | düz yazılır: `63,3 V` |
| `*_estimated_*` | sürücünün tahmini | `≈65,9 V` |
| `*_reported_*` | ham ölçüm | yalnızca "Teknik detay"da |
| `*_plausible: false` | ham değer doğrulanamadı | `0,592 A *` + dipnot |
| `*_implausibility_reason`, `*_estimation_reason` | sebep kodu | Türkçeye çevrilir (`src/lib/d4i.ts`) |
| `<key>_count_saturated` + `<key>_count_text` | sayaç tavana ulaştı | `253+` |

Okuma sırası tek yerde: `readMeasurement` → doğrulanmış → tahmini → ham. Yalnızca
`voltage_v` gönderen eski firmware ilk kuraldan geçtiği için **geriye uyumludur**.

> `d4i_telemetry.led_voltage_v / led_current_a / led_temperature_c` sütunları
> yalnızca **doğrulanmış** değeri taşır; doğrulama başarısızsa NULL kalırlar.
> Panel ölçümleri bu yüzden sütunlardan değil ham `raw` bloğundan okur.
> `bank_206_*`, ölçek üsleri ve `*_available/plausible` alanları ana ekranda
> değil, lamba kartının katlanır "Teknik detay" bölümündedir.

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
