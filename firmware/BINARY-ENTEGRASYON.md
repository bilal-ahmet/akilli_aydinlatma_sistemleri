# Binary MQTT protokolü v1 — backend entegrasyonu

Protokolün kendisi (paket biçimi, alan tablosu, enum'lar, JSON'a çevirme
kuralları) firmware ekibinin dokümanındadır: **MQTT Binary Protokolü v1, rev 1.0
(3 Kasım 2026)** → `firmware/MQTT-BINARY-PROTOKOL.html`. Bu not, bizim tarafta
nasıl uygulandığını ve uyulması gereken kuralları anlatır.

## Akış

```
ESP32 (yeni firmware) ──binary──▶ Meven:<MAC>/bin ──▶ backend (+/bin aboneliği)
                                                        │ lib/binproto: CRC + çözme + JSON'a çevirme
                                                        ▼
                                   bugünkü JSON'un aynısı → routeUplink → handleD4i / handleHealth
```

- Yeni firmware **bütün uplink'ini** `Meven:<MAC>/bin`'e basar; `/data` ve
  `/health`'e artık yazmaz. Eski firmware'li cihazlar JSON basmaya devam eder,
  ikisi aynı anda desteklenir.
- Çözücü **backend'in içindedir** (TypeScript). Firmware ekibinin
  `scripts/mqtt_bridge.py` köprüsü ayrı servis olarak **çalıştırılmaz**;
  çevirme kuralları ondan birebir porte edildi (`src/lib/binproto/toJson.ts`).
- Komutlar **topic başına** binary ya da JSON gider. Cihaz iki biçimi de kabul
  eder: binary komuta `/bin`'e binary ack, JSON komuta `/data`'ya JSON ack
  döner (bkz. "Komutlar").

## Komutlar (sunucu → cihaz)

| Topic | Biçim |
|---|---|
| `Meven:<MAC>/cmd` (bakım dahil) | Cihaz binary-yetenekliyse binary, değilse JSON |
| `Meven:<slug>/cmd` (bölge, müşteri "Tüm Sistem"i) | Bölgenin kayıtlı cihazlarının **hepsi** binary-yetenekliyse binary, değilse JSON |
| `Meven:all/cmd` | Her zaman JSON (kayıtsız cihazlar da dinliyor) |

- **Binary-yetenekli** (`binCommandCapable`): geçerli `/bin` paketi görülmüş
  ve ondan sonra JSON telemetri/health gelmemiş. Süre sınırı yok (cihaz
  dakikalarca sessiz kalabilir). OTA ile eski firmware'e dönen cihaz JSON
  basmaya başlar ve hemen JSON komuta düşer. Backend yeniden başladığında
  cihazın ilk binary paketine kadar JSON gider.
- **Sınır:** bölge kararı DB'deki kayıtlara göre verilir. Panele eklenmemiş
  ama o bölge slug'ıyla flaşlanmış eski firmware'li bir cihaz binary bölge
  komutunu anlamaz (`gecersiz json`).
- `on`/`off` kabloda `dim 100/0`'dır. Tüm lambalar için kanal alanı yazılmaz
  (binary'de "broadcast"). Efekt durdurma kanalsız `dim` ile yapılır;
  `number 0` kullanılmaz.
- **Kısa id:** `COMMAND_ID` u16 (1–65535), UUID kabloya çıkmaz. Sayaç backend
  genelinde tektir, cihaz başına değil: bölge komutu tek id ile çok cihaza
  gider, cevaplar MAC topic'inden ayrılır. 1 bayt, 10 dk'lık eşleşme
  penceresinde dönebileceği için 2 bayt seçildi. Başlangıç rastgele.
  `src/lib/binproto/shortIds.ts`.
- **Binary ack:** id UUID'ye çevrilir ve JSON ack ile aynı yoldan işlenir
  (delivered/failed, rozet, arıza geçmişi, Bakım sekmesi). Eşlenemeyen ack
  (restart sonrası, süresi geçmiş, id'siz -15/-16/-17) bir komutu tahminle
  `failed` yapmaz; hata yine cihaz rozetine yazılır.
- **Toplu komuta cevap yok** (firmware kararı, binary ve JSON): bölge ve
  `all` topic'lerine gelen komuta cihaz başarı cevabı dönmez. `commands`
  satırı cihazın sonraki telemetrisiyle `delivered` olur. Firmware ileride
  yalnızca hata cevabını rastgele gecikmeyle gönderirse id ile bölge
  komutuna bağlanır.
- **Kapatma anahtarı:** `MQTT_BINARY_COMMANDS=off` → bütün komutlar JSON.
- Admin kartı cihaz başına komut biçimini gösterir.

## Kod

| Dosya | Görev |
|---|---|
| `src/lib/binproto/fields.ts` | Alan tablosu (138 alan) + enum'lar — `msg_fields.h`'nin kopyası |
| `src/lib/binproto/codec.ts` | CRC-16/CCITT-FALSE, `decodeFrame`, `encodeFrame` |
| `src/lib/binproto/toJson.ts` | Python `to_legacy` portu (d4i, health, ack, commission…) |
| `src/lib/binproto/espErr.ts` | OTA hata kodu → ESP-IDF adı |
| `src/lib/binproto/command.ts` | `encodeCommand` (TYPE = COMMAND) |
| `src/lib/binproto/shortIds.ts` | Kısa komut id'si ↔ UUID tablosu |
| `src/lib/binUplink.ts` | Sunucu katmanı: sayaçlar, alarm, health önbelleği, çift işleme koruması |
| `src/lib/mqtt.ts` | `+/bin` aboneliği (QoS 1), `handleBinUplink` → `routeUplink`; `publishCommand` biçim seçimi |
| `GET /api/admin/binproto` + `src/app/admin/BinaryProtocol.tsx` | Admin kartı |

## Kurallar

1. **Alan tablosu önce, OTA sonra.** Firmware yeni bir alan eklediğinde önce
   `src/lib/binproto/fields.ts` güncellenir, `npm run check:binproto` geçer,
   deploy edilir; ancak ondan sonra cihazlara OTA yapılır. Tanımsız alan taşıyan
   paket **tamamen atılır**: o cihazın verisi panelde görünmez, admin sayfasında
   kırmızı uyarı çıkar. Mevcut bir alanın kodu, boyu ya da anlamı değişmez;
   biçim değişirse versiyon baytı artar.
2. **Python köprüsü canlıda yalnızca salt-okur modlarda çalıştırılır**
   (`--watch`, `--compare`). Köprü modunda çalışırsa her paket JSON olarak
   ikinci kez basılır. Backend bunu "çift işleme koruması" ile atlar ama
   kaynağında önlenmeli.
3. **Çift işleme koruması:** son 10 dk'da geçerli binary gönderen bir MAC'ten
   gelen JSON telemetri ve health atlanır (`binActive`). JSON ack'ler işlenmeye
   devam eder. Bu, hem JSON hem binary basan doğrulama firmware'ini de kapsar.
4. **Bir-kezlik health alanları** (`idf_version`, `build_date/time`,
   `thread.network_name`) bağlantı başına bir kez gelir ve cihaz başına bellekte
   tutulur. Backend yeniden başlarsa ilk health'te `devices.health`'teki son
   değerle tohumlanır.
   **Rapor aralıkları** (`0xB9 HEALTH_INTERVAL_S` → `health_interval_s`,
   `0xBA HEALTH_REPORT_INTERVAL_S` → `report_interval_s`, u32 saniye; 06.11.2026)
   yalnızca ilk kayıtta (join) gelir. Önbelleğe alınmaz, `devices`
   sütunlarında kalıcı tutulur; panelin "bağlantı yok" ve ölçüm tazelik
   pencereleri bunlardan hesaplanır (`src/lib/deviceWindows.ts`). Backend
   join anında kapalıysa (deploy) değer kaçırılır ve cihaz bir sonraki join'e
   kadar varsayılan pencereyle (3 dk) değerlendirilir.
5. **LoRa gateway paketleri** (ilk bayt `0x02`) bu fazda desteklenmez. Hata
   sayılmaz; admin kartında "LoRa (desteklenmiyor)" olarak sayılır.

## Python köprüsünden bilinçli sapmalar

Aşağıdaki maddeler firmware ekibine de iletildi:

- **Eksik zorunlu alan:** sürücü/LED bloğunda bir alan eksikse Python
  `KeyError` atıp **köprü sürecini düşürüyor** (`run_bridge` yalnızca
  `FrameError` yakalıyor). Backend bu paketi `MISSING_FIELD` ile reddedip
  alarm üretir.
- **`load_power` maskesi:** Python maskeli ham değeri (`0xFFFFFFFF`) ya da
  geçersiz ölçeği olduğu gibi çarpıyor ve 4.294.967.295 W yazıyor. Backend
  `value: null` + `status` yazar, panel özetindeki toplam bozulmaz.
- **Adressiz d4i_periodic** reddedilir; zaten hiçbir lambaya bağlanamazdı.

## Test

- `npm run check:binproto`: dokümandaki CRC kontrol değerleri ve 6 örnek
  paket, Python `selftest` beklentileri, ret durumları, şema uyumu (`parseUplink`,
  `deviceHealthSchema`, `activeFaultCodes`).
- `npm run mock:device <MAC> <kanal> <bölge> --bin`: sanal cihaz binary basar
  (d4i_periodic, health, HELLO). Binary komuta binary ack, JSON komuta JSON
  ack döner. `--bin` olmadan eski firmware gibi binary komuta `gecersiz json`
  der.
- `npm run watch:cmd [MAC]`: backend'in bastığı komutları gösterir; binary
  komutu hex + çözülmüş haliyle yazar.
- `npm run mock:bin <MAC> <hex…>` / `--ornek d4i|dali|health|ack|crc|alan|lora`:
  yakalanan paketleri yeniden oynatır. Yerel olmayan broker'da `--canli`
  ister; canlıya basılan paket gerçek veri gibi işlenir.

## Devreye alma

1. Backend deploy edilir. Eski firmware'li cihazlar etkilenmez.
2. **Tek test cihazına** OTA yapılır (Kural #17).
   - `python mqtt_bridge.py --watch <MAC> --json` (salt-okur) ile referans
     JSON izlenir.
   - Panelde kontrol: lambalar, D4i paneli, güç/enerji özeti, arızalar,
     Bakım sekmesi, komut + ack. `npm run watch:cmd <MAC>` ile komutun
     binary gittiği görülür (cihazın ilk raporundan sonra).
   - Admin kartı ret göstermemeli.
3. Filoya kademeli OTA, cihaz cihaz.

## Sonraki fazlar

- **`Meven:all/cmd` binary:** bütün filo yeni firmware'deyken. Ardından
  cihazdaki JSON komut desteği kaldırılabilir (firmware ekibiyle).
- **LoRa gateway protokolü (0x02):** `lora_protocol.py` ve dokümanı bekleniyor.
- Firmware ekibinden `msg_codec.py` ve `esp_err_names.py` gelirse, sahadan
  yakalanan paketlerle Python ↔ TS altın veri testi eklenir.
