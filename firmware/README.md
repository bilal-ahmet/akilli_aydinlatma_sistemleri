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
3. Cihaz kimliği **otomatik**: sketch açılışta `WiFi.macAddress()` ile kendi MAC'ini okur ve iki noktasız kullanır (örn. `A842E3123456`). Elle id ayarlamana gerek yok.
4. Kartı USB ile bağla, doğru **Port**'u seç, **Upload**.
5. **Serial Monitor**'ü 115200 baud'da aç → `[wifi] OK`, `[id] MAC: ...`, `[mqtt] OK`, `subscribe MEVEN:<MAC>/cmd , MEVEN:all/cmd` satırlarını görmelisin.
6. Serial'deki MAC'i dashboard'da **Cihazlar → Yeni Cihaz**'dan ekle (ilgili bölgeyi seç) — böylece gelen veri o bölgeyle eşleşir.

## Donanım
- Test için **dahili LED** (GPIO2) yeterli — ekstra bağlantı gerekmez.
- Harici LED istersen: `LED_PIN`'i değiştir, LED + ~220Ω direnç ile o GPIO ↔ GND.
- Dim, PWM (8-bit) ile yapılır; `brightness` %0–100 → duty 0–255.

## Test akışı (uçtan uca)
1. ESP32 açık, Serial Monitor'de bağlı; MAC'i dashboard'da kayıtlı.
2. Canlı dashboard'u aç (Railway URL'in).
3. Cihazın bölgesini aç/kapat/dim yap (veya "Tüm Sistem").
4. Beklenen:
   - Serial Monitor'de `[mqtt] msg <- MEVEN:<MAC>/cmd` (veya `MEVEN:all/cmd`) + `[cmd] action=...`
   - LED yanar/söner/parlaklığı değişir.
   - ESP32 `MEVEN:<MAC>/data`'ya publish eder → backend `device_status`'a yazar, `commands` satırı `delivered` olur, dashboard SSE ile teyit alır; cihaz listesinde sıcaklık/RSSI görünür.
5. Cihaz 30 sn'de bir heartbeat data'sı yollar → dashboard'da cihaz "canlı" kalır.

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
