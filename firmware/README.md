# ESP32 Firmware — Fener

Gerçek ESP32'yi HiveMQ Cloud üzerinden backend'e bağlayıp dashboard'dan
kontrol etmek için Arduino sketch'i.

## Gerekli kütüphaneler (Arduino IDE → Tools → Manage Libraries)
- **PubSubClient** (Nick O'Leary)
- **ArduinoJson** (Benoit Blanchon, **v7**)
- `WiFiClientSecure` — ESP32 board paketiyle gelir (ayrı kurmaya gerek yok)

## Board paketi
- Tools → Board → Boards Manager → **"esp32" by Espressif** (core **3.x** önerilir; sketch `ledcAttach` API'sini kullanır).
- Board olarak kartını seç (ör. "ESP32 Dev Module").

## Kurulum adımları
1. `esp32-fener/` klasörünü Arduino IDE'de aç (`esp32-fener.ino`).
2. `secrets.example.h`'ı **`secrets.h`** olarak kopyala, WiFi ve HiveMQ bilgilerini gir.
   HiveMQ değerleri Railway'deki `MQTT_HOST/USER/PASS` ile aynı (kendi cluster'ın).
   `secrets.h` gitignore'lu olduğu için credential'ların repoya gitmez.
3. `esp32-fener.ino` içinde cihaz kimliğini ayarla — **backend'deki `devices` tablosuyla eşleşmeli**:
   ```cpp
   #define DEVICE_ID "ataturk-bulvari-001"
   #define ZONE_ID   "ataturk-bulvari"
   ```
   > Seed'de her zone için `{slug}-001..003` cihazları var. Farklı bir cihaz/zone denemek istersen Neon'daki `devices`/`zones` tablolarına bak.
4. Kartı USB ile bağla, doğru **Port**'u seç, **Upload**.
5. **Serial Monitor**'ü 115200 baud'da aç → `[wifi] OK`, `[mqtt] OK`, `subscribe ...` satırlarını görmelisin.

## Donanım
- Test için **dahili LED** (GPIO2) yeterli — ekstra bağlantı gerekmez.
- Harici LED istersen: `LED_PIN`'i değiştir, LED + ~220Ω direnç ile o GPIO ↔ GND.
- Dim, PWM (8-bit) ile yapılır; `brightness` %0–100 → duty 0–255.

## Test akışı (uçtan uca)
1. ESP32 açık ve Serial Monitor'de bağlı.
2. Canlı dashboard'u aç (Railway URL'in).
3. **"Atatürk Bulvarı"** zone'unu aç/kapat veya parlaklığı değiştir.
4. Beklenen:
   - Serial Monitor'de `[mqtt] msg <- city/lighting/zone/ataturk-bulvari/command` + `[cmd] action=... → isOn=...`
   - LED yanar/söner/parlaklığı değişir.
   - ESP32 status publish eder → backend `device_status`'a yazar, `commands` satırı `delivered` olur, dashboard SSE ile teyit alır.
5. Cihaz 30 sn'de bir heartbeat status'u yollar → dashboard'da cihaz "canlı" kalır.

## Güvenlik notu (TLS)
Sketch hızlı test için `net.setInsecure()` kullanır (sertifika doğrulaması yok —
şifre yine de TLS ile şifreli gider ama MITM'e karşı zayıf). Üretimde, `setup()`
içinde şu satırı kök sertifika ile değiştir:

```cpp
// net.setInsecure();
net.setCACert(HIVEMQ_ROOT_CA); // ISRG Root X1 (Let's Encrypt) PEM'ini ekle
```

HiveMQ Cloud sertifikaları Let's Encrypt iledir; **ISRG Root X1** PEM'ini bir
`const char*` olarak tanımlayıp kullanabilirsin.
