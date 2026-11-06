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
- Komutlar şimdilik **JSON**'dur. Cihaz JSON komuta JSON ack döner (`/data`).
  Binary komut bu fazda yoktur. Binary ack gelirse loglanır ama işlenmez,
  çünkü içindeki u16 id hiçbir komutumuza eşlenemez.

## Kod

| Dosya | Görev |
|---|---|
| `src/lib/binproto/fields.ts` | Alan tablosu (136 alan) + enum'lar — `msg_fields.h`'nin kopyası |
| `src/lib/binproto/codec.ts` | CRC-16/CCITT-FALSE, `decodeFrame`, `encodeFrame` |
| `src/lib/binproto/toJson.ts` | Python `to_legacy` portu (d4i, health, ack, commission…) |
| `src/lib/binproto/espErr.ts` | OTA hata kodu → ESP-IDF adı |
| `src/lib/binUplink.ts` | Sunucu katmanı: sayaçlar, alarm, health önbelleği, çift işleme koruması |
| `src/lib/mqtt.ts` | `+/bin` aboneliği (QoS 1), `handleBinUplink` → `routeUplink` |
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
  (d4i_periodic, health, HELLO); JSON komuta JSON ack döner.
- `npm run mock:bin <MAC> <hex…>` / `--ornek d4i|dali|health|ack|crc|alan|lora`:
  yakalanan paketleri yeniden oynatır. Yerel olmayan broker'da `--canli`
  ister; canlıya basılan paket gerçek veri gibi işlenir.

## Devreye alma

1. Backend deploy edilir. Eski firmware'li cihazlar etkilenmez.
2. **Tek test cihazına** OTA yapılır (Kural #17).
   - `python mqtt_bridge.py --watch <MAC> --json` (salt-okur) ile referans
     JSON izlenir.
   - Panelde kontrol: lambalar, D4i paneli, güç/enerji özeti, arızalar,
     Bakım sekmesi, JSON komut + ack.
   - Admin kartı ret göstermemeli.
3. Filoya kademeli OTA, cihaz cihaz.

## Sonraki fazlar

- **Binary komutlar:** bütün filo geçtikten sonra. Gerekenler: u16 id ↔ UUID
  eşlemesi, binary ack'in işlenmesi, efekt durdurmada `number 0`. Bölge ve
  `all` topic'leri ancak bütün filo yeni firmware'deyken binary'ye geçer.
- **LoRa gateway protokolü (0x02):** `lora_protocol.py` ve dokümanı bekleniyor.
- Firmware ekibinden `msg_codec.py` ve `esp_err_names.py` gelirse, sahadan
  yakalanan paketlerle Python ↔ TS altın veri testi eklenir.
