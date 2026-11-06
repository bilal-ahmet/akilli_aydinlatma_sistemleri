# Binary MQTT protokolü v1'e geçiş: backend içinde TypeScript çözücü

## Bağlam

Firmware ekibi cihazların MQTT mesajlarını JSON yerine kompakt binary pakete
çeviriyor: d4i_periodic 2137 B'tan ≤170 B'a, health 1180 B'tan ~105 B'a iniyor.
Yeni firmware'li cihaz bütün uplink'ini `Meven:<MAC>/bin`'e basıyor ve `/data`,
`/health`'e artık yazmıyor. Backend hazır olmadan tek bir cihaza OTA gönderilirse
dashboard o cihazı göremez.

**Karar (güncellendi):** Python köprüsü ayrı servis olarak çalıştırılmayacak.
Çözücü **backend'in içine TypeScript ile** yazılacak:
- `+/bin` doğrudan dinlenir.
- Paket çözülür ve köprünün üreteceği JSON'un aynısına çevrilir.
- Bu JSON mevcut `handleD4i` / `handleAck` / `handleHealth` yoluna verilir.

Sonuç: ek Railway servisi yok, broker'da çift trafik yok, ayrı bir arıza noktası
yok. (Güncelleme, 2026-11-06: komutlar da binary'ye geçti — topic başına seçim,
u16 kısa id; bkz. `firmware/BINARY-ENTEGRASYON.md` §Komutlar.) İlk fazda komutlar **JSON** kaldı; cihaz geçiş döneminde JSON komutu kabul
ediyor ve JSON ack dönüyor. Arkadaşının `mqtt_bridge.py` dosyası, çevirme
kurallarının **referans uygulaması** olarak birebir porte edilecek. Ayrıca
canlı broker'da salt-okur `--watch --json` modunda karşılaştırma aracı olarak
kullanılabilir.

## `mqtt_bridge.py` değerlendirmesi

Genel olarak doğru ve HTML dokümanla tutarlı. Çevirme kuralları açık yazılmış,
`selftest` içinde elle hesaplanmış beklentiler var; bunları TS testlerine
taşıyacağım. Porte ederken dikkat edilecek ve arkadaşına iletilecek noktalar:

1. **Yeni bilgi, LoRa gateway'i (ilk bayt 0x02):** Aynı `/bin` topic'ine
   `lora_protocol.py` ile çözülen ayrı bir protokol basılıyor. Çıktısı `/data`,
   `/cmd_result` ve `/status` topic'lerine gidiyor (`gw_status`, `telemetry`,
   `cmd_result` tipleri). HTML dokümanda bundan hiç söz yok; bizim backend de bu
   topic'leri ve tipleri tanımıyor. Bu iş ayrı bir faz. Bu planda 0x02 paketleri
   **reddedilmez, alarm da üretmez**: sayılır, cihaz başına bir kez loglanır ve
   "desteklenmeyen LoRa paketi" olarak admin kartında görünür.
2. **Köprünün çökme riski:** `driver_object` / `led_object` alanları
   `fields["..."]` ile zorunlu okuyor. Banka sürümü gelip bir alan eksik
   kalırsa `KeyError` atılıyor. `run_bridge` yalnızca `FrameError` yakaladığı
   için süreç ölüyor; cihaz aynı paketi bastıkça bu bir çökme döngüsüne dönüşür.
   TS'te mesaj başına try/catch olacak. Eksik zorunlu alan `MISSING_FIELD`
   ile reddedilir ve alarm üretir.
3. **`load_power` maskelenmiyor:** Ham değer `0xFFFFFFFF` ya da ölçek geçersizse
   `value` 4.294.967.295 W çıkıyor. `/api/summary` yük gücünü topladığı için
   panel özeti bozulur. TS'te maskeli/geçersiz ölçek `value: null` +
   `status` olacak. Bu, Python'dan **bilinçli sapma**; arkadaşına da düzeltmesini
   öneririz.
4. **Alarm yok:** Tanımsız alan ve bilinmeyen enum yalnızca loga yazılıyor.
   Doküman "alarm üretin" diyor; bunu admin kartı karşılayacak (adım 5).
5. **HELLO, `/data`'ya düz `"data"` metni basıyor.** Bugünkü firmware de bunu
   yapıyor olmalı: bizim backend her açılışta `JSON çözülemedi` uyarısı yazıyor.
   İki yolda da sessizce atlanacak.
6. **`reset_reason` artık enum adının küçük harfi:** `power_on`, `task_wdt`
   (eskiden `ESP_RST_*` olabilir). `ota.last_message` enum metni, hata
   durumunda ESP-IDF hata adı. `firmware_version` / `last_target_version`
   yoksa `""`. Mevcut UI bunları zaten kaldırabiliyor
   (`DeviceMaintenance.tsx` boş metni gizliyor, `handleHealth` boş sürümle
   eskisini ezmiyor).
7. **`health.device_id` = `"Meven:<MAC>"`** (önekli). Bizde kullanılmıyor,
   olduğu gibi bırakılır.
8. **Sayısal hassasiyet:** `scaled()` C'deki gibi döngüyle ×10 / ÷10 yapıyor.
   TS'te `raw * 10 ** exp` yazılmayacak, aynı döngü kullanılacak. Python float'u
   ile JS number'ı aynı IEEE double olduğu için sonuçlar birebir çıkar. 48 bit
   enerji `high * 2**32 + low` olarak hesaplanır (2^53 altında, güvenli);
   `raw_integer` metin olarak tutulur.
9. **Eksik dosyalar:** Betik `msg_codec.py`, `esp_err_names.py` ve
   `lora_protocol.py` olmadan çalışmıyor. Bunlar `command_ack_to_json`, enum
   tabloları ve ESP-IDF hata adlarını taşıyor. Tablolar ve ack metinleri
   HTML'de var; ESP-IDF hata adları için kendi tablomuzu yazacağız. Dosyalar
   gelirse altın test verisi üretmekte kullanılır (Doğrulama).

## Protokolün bizi etkileyen kısmı (kısa)

- **Paket yapısı:** `0x01` + `[kod][değer]…` + CRC-16/CCITT-FALSE (LE). İlk alan
  TYPE. Değeri olmayan alan yazılmıyor, JSON'daki `null` buradan geliyor.
  Değişken boylu alanın önünde 1 bayt uzunluk var. Health'te `NEIGHBOR_*`
  alanları tekrar ediyor.
- **Tanımsız alan paketi tamamen düşürür.** Firmware yeni alan eklerse **önce
  `fields.ts` güncellenip deploy edilir, sonra OTA yapılır.**
- **Bağlantı başına bir kez gelen alanlar:** `idf_version`,
  `build_date/time` ve `thread.network_name` bağlantı başına bir kez geliyor.
  Cihaz başına önbellekte tutulur. Backend her deploy'da yeniden başladığı için
  önbellek boşsa ilk health'te `devices.health`'teki eski değerle tohumlanır
  (Python köprüsünde bu yok).
- **`d4i.bank_206_raw_hex` kaldırıldı.** D4iPanel null'a dayanıklı
  (`D4iPanel.tsx:472`). Yeni sebep kodları geliyor: `led_voltage_current_mismatch`
  ve 13 `measurement_status` kodu. Yeni firmware hata metinleri de var (-13…-17).

## Adımlar

### 0. `binary_protocol.md`'yi bu planla güncelle (kök dizin)

### 1. Alan tablosu ve codec: `src/lib/binproto/` (saf, sunucu/istemci bağımsız)
- `fields.ts`:
  - Alan tablosu `kod → { name, size (0 = değişken), kind }`. `kind` değerleri:
    u8, u16, u24, u32, i8, i32, bytes, list, text. Kaynak HTML'deki tablo
    (rev 1.0, 136 alan).
  - Enum'lar: TYPE, ERROR, DECODE_ERROR, MEASUREMENT_STATE/STATUS,
    LOAD_POWER_CHECK, COMMISSION_TRIGGER, COMMAND_ACTION, COMMAND_RESULT (+
    JSON hata metinleri), RESET_REASON, THREAD_ROLE, OTA_STATE/RESULT,
    OTA_MESSAGE metinleri.
  - Başlık yorumu: kaynak `msg_fields.h`, "önce bu dosya, sonra OTA" kuralı.
- `codec.ts`:
  - `crc16`.
  - `decodeFrame(buf)` → `{ ok, type, fields: [name, value][] }` ya da
    `{ ok:false, reason }`. Reason değerleri: TOO_SHORT, VERSION, CRC, FIELD,
    TRUNCATED, NO_TYPE, LORA. Paket tamamen doğrulanmadan hiçbir alan kullanılmaz.
  - `encodeFrame(type, fields)`: mock cihaz, testler ve ileride binary komutlar
    için.
- `espErr.ts`: OTA'da görülebilecek ESP-IDF hata adları: genel, `ESP_ERR_OTA_*`,
  `ESP_ERR_HTTP_*`, `ESP_ERR_HTTPS_OTA_*`. `esp_err_names.py` gelirse ondan
  tamamlanır.
- `toJson.ts`: `mqtt_bridge.py`'nin `to_legacy` ve yardımcılarının birebir
  portu: `d4iPeriodicJson`, `daliStatusJson`, `d4iBankJson`, `commissionJson`,
  `commandAckJson`, `healthJson`, `addCounter`, `addFault`,
  `energyPowerObjects`, `driverObject`, `ledObject`, `versionText`,
  `buildDateTime`, `otaMessageText`.
  - Çıktı: `{ suffix: "data" | "health", payload }`, HELLO için `{ hello: true }`.
  - Bilinçli sapmalar yalnızca değerlendirmedeki 2. ve 3. madde.
    Bilinmeyen enum değeri `"unknown"` yazılır ve loglanır, paket reddedilmez.

### 2. Backend alım yolu
- `src/lib/topics.ts`: `BIN_WILDCARD = "+/bin"`, `binTopic(mac)`,
  `parseBinTopic(topic)` eklenir. `UplinkSuffix` aynı kalır.
- Yeni `src/lib/binUplink.ts` (sunucu):
  - Akış: `decodeFrame` → istatistik → health önbelleği (globalThis Map + DB
    tohumu) → `toJson` → `{ mac, suffix, json }`.
  - Reddedilen paket loglanır: cihaz başına saatte bir, hex ile.
- `src/lib/mqtt.ts`:
  - Abonelikler: `+/data` ve `+/health` QoS 0, `+/bin` QoS 1 (health
    cihazdan QoS 2 ile geliyor).
  - `message` handler `/bin` topic'ini `handleBinMessage`'a yollar.
    `handleUplink`, `JSON.parse` + topic çözme ile `routeUplink(mac, suffix,
    json)` olarak ikiye bölünür. Binary yol çözdüğü JSON'u doğrudan
    `routeUplink`'e verir; aşağıdaki her şey (gateway ayrımı, d4i, ack,
    health) değişmeden çalışır.
  - **Phase 1'de binary COMMAND_ACK loglanır, DB'ye işlenmez.** Biz yalnızca
    JSON komut (UUID id) gönderiyoruz; bizim komutlarımızın ack'i JSON gelir.
    Binary ack'teki u16 id hiçbir komutumuza eşlenemez. Mevcut yedek yol
    ("en son bekleyen komut") burada yanlış komutu `failed` yapardı.
  - **Çift işleme koruması:** son 10 dk'da geçerli `/bin` gönderen MAC'in JSON
    `/data` telemetrisi ve `/health`'i atlanır; JSON ack'leri işlenmeye devam
    eder. İki durumu kapsar:
    - doğrulama firmware'i JSON + binary'yi birlikte basarsa;
    - biri canlı broker'da `mqtt_bridge.py`'yi köprü modunda çalıştırırsa.

    İkisinde de aynı rapor iki kez yazılırdı.
  - HELLO (`"data"` metni) ve bilinen ama işlenmeyen tipler (`dali_status`,
    `d4i`, `commission_result`) iki yolda da sessizce atlanır.
    `src/types/lighting.ts` → `parseUplink` buna göre güncellenir.
  - `/bin`, kayıtlı bir gateway MAC'inden gelirse ya da 0x02 (LoRa) paketiyse
    sayılır ve atlanır.

### 3. Katalog uyumu
- `src/lib/deviceErrors.ts`: yeni metinler, teknik + sade:
  - `d4i rapor servisi henuz hazir degil`
  - `cihaz mesgul, komut kuyrugu dolu`
  - `crc hatali, paket islenmedi`
  - `desteklenmeyen protokol versiyonu`
  - `paket bicimi bozuk`

  dim/efekt regex'leri `( veya 255)` biçimini zaten kabul ediyor.
- `src/lib/d4i.ts` → `REASONS`: `led_voltage_current_mismatch` ve 13
  `measurement_status` kodunun Türkçe etiketleri.
- `DeviceMaintenance.tsx`: `reset_reason` enum adları için küçük bir etiket
  haritası (yalnızca admin görüyor). Bilinmeyen değer ham gösterilir.
- Mobil (Kural #16): `deviceErrors` ve `d4i` kopyaları güncellenmeli (sana not).

### 4. Test araçları
- `scripts/check-binproto.ts` → `npm run check:binproto` (tsx). Kontroller:
  - **CRC:** `"123456789"` → `0x29B1`; doküman paketinin ilk 25 baytı →
    `0x03C8`.
  - **Doküman örnekleri:** 6 örnek paket çözülür.
  - **Örnek JSON:** d4i_periodic örneği dokümandaki JSON'un birebir aynısını
    üretir.
  - **Python selftest'i porte edilir:**
    - enerji; doymuş güç; geçersiz ölçek;
    - hata/sayaç kuralı; düzeltilmiş LED;
    - sürüm ve derleme zamanı;
    - OTA mesajı; çevrimdışı lamba;
    - çözülemeyen bank; komşu listesi.
  - **Ret durumları:** kısa, versiyon, CRC, tanımsız alan, taşma, TYPE'sız,
    0x02, eksik zorunlu alan.
  - **Gidiş-dönüş:** encode → decode.
  - **Şema uyumu:** çıktı JSON `parseUplink` / `deviceHealthSchema`'dan geçer,
    `activeFaultCodes` beklenen kodları döner.
  - **Altın veri (isteğe bağlı):** `scripts/fixtures/binproto/*.json`.
- `scripts/mock-device.ts --bin`: sanal cihaz d4i_periodic, health ve ack'i
  `encodeFrame` ile binary basar. Böylece tüm panel donanımsız denenir.
- `scripts/publish-bin.ts` → `npm run mock:bin <MAC> <hex…>`: yakalanan
  gerçek paketleri yeniden oynatmak için.

### 5. Admin görünürlüğü (dokümandaki "alarm")
- `src/lib/binUplink.ts` içinde bellek içi sayaçlar tutulur:
  - nedenlere göre ret sayısı ve cihaz başına son ret (zaman, neden, alan kodu);
  - binary gönderen cihazlar ve LoRa paket sayısı.
- `GET /api/admin/binproto` (`authorizeAdmin`).
- `src/app/admin/BinaryProtocol.tsx`: `DiscoveredGateways.tsx` desenini izler
  (`useReconcile` ile yenileme), `AdminClient.tsx`'e eklenir.
  - Son 24 saatte `FIELD` / `MISSING_FIELD` varsa kırmızı bant: "Cihaz
    backend'in tanımadığı bir alan gönderiyor, alan tablosu güncellenmeli
    (`src/lib/binproto/fields.ts`)".
  - Sorun yoksa tek satır özet.

### 6. Dokümantasyon
- `firmware/MQTT-BINARY-PROTOKOL.html`: protokol dokümanı (rev 1.0), sen
  kopyalarsın.
- `firmware/BINARY-ENTEGRASYON.md`:
  - backend'de çözme;
  - tablo güncelleme kuralı;
  - Python köprüsünün canlıda **yalnızca `--watch` / `--compare`** ile
    çalıştırılabileceği;
  - LoRa'nın kapsam dışı olduğu;
  - arkadaşına iletilecek değerlendirme maddeleri.
- `CLAUDE.md`:
  - mimari şemaya `/bin` eklenir;
  - topic listesine `Meven:<MAC>/bin` eklenir;
  - yeni kural: alan tablosu önce, OTA sonra; binary ack phase 1'de işlenmez;
  - çift işleme koruması anlatılır;
  - `bank_206_raw_hex` notu düzeltilir;
  - klasör yapısına `lib/binproto` eklenir.
- `firmware/ESP32-ENTEGRASYON.md`: binary uplink notu ve yeni hata metinleri.

## Devreye alma sırası
1. Kod `master`'a gider. Eski firmware'li cihazlar etkilenmez, `/bin` boş kalır.
2. Arkadaşına iletilecekler:
   - üretimde köprünün **köprü modunda çalıştırılmayacağı**;
   - değerlendirme maddeleri;
   - eksik `.py` dosyaları ve LoRa dokümanı ricası.
3. **Tek test cihazına** OTA (Kural #17).
   - Aynı anda `python mqtt_bridge.py --watch <MAC> --json` (salt-okur) ile
     referans JSON izlenir.
   - Dashboard'da kontrol edilecekler: lambalar, D4i paneli (Teknik detay
     dahil), güç/enerji özeti, arızalar, Bakım sekmesi (firmware/OTA),
     JSON komut + ack.
   - Admin kartı ret göstermemeli.
4. Filoya kademeli OTA, cihaz cihaz. `otaGuard` aralığı zaten zorluyor.
5. Firmware yeni alan eklediğinde: önce `fields.ts` + test + deploy, sonra OTA.

## Doğrulama
- `npm run check:binproto`, `npx tsc --noEmit`, `npm run lint`.
- Yerel uçtan uca test, canlıya dokunmadan (memory `local-testing-env`):
  - Ortam: PGlite (5433) + aedes TLS (18883); Next yerel env ile başlatılır.
  - `npm run mock:device <MAC> 3 <bölge> --bin` çalıştırılır. Beklenenler:
    - `d4i_telemetry.raw` doğru;
    - `fixtures` ve arıza rozetleri doğru;
    - `devices.health` + `kind:"health"` olayı geldi;
    - OTA akışı Bakım sekmesinde görünüyor;
    - JSON komut + JSON ack çalışıyor.
  - `npm run mock:bin` ile bozuk CRC'li ve tanımsız alanlı paketler basılır;
    admin kartında kırmızı bant çıkmalı.
  - Aynı MAC'ten JSON telemetri basılınca çift işleme koruması devreye girmeli.
- Altın veri: arkadaşın `msg_codec.py` + `esp_err_names.py` gönderirse,
  scratchpad'de küçük bir Python betiğiyle sahadan yakalanmış paketler için
  `{hex, suffix, json}` üretilir. TS çıktısıyla derin eşitlik testi eklenir
  (float toleransı 1e-9, Python'daki gibi).

## Kapsam dışı (sonraki fazlar)
- **Binary komutlar** (bütün filo geçince). Gerekenler: u16 id ↔ UUID eşlemesi
  (`inflight`), binary ack'in işlenmesi, efekt durdurmada `number 0`. Bölge ve
  all topic'leri ancak bütün filo geçince binary'ye döner.
- **LoRa gateway protokolü (0x02):** `/cmd_result`, `/status`, `gw_status`,
  `telemetry` ve `cmd_result` tipleri. `lora_protocol.py` ve dokümanı
  bekleniyor.
- `commission_result`'ı Bakım sekmesinde göstermek ("3 lamba bulundu, 2,1 sn").
- `msg_fields.h` + `msg_fields.c`'den `fields.ts` üreten betik (dosyalara
  erişim olursa).
