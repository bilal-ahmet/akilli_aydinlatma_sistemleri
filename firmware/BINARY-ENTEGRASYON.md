# Binary MQTT protokolü v1 — backend entegrasyonu

Protokolün kendisi (paket biçimi, alan tablosu, enum'lar, JSON'a çevirme
kuralları) firmware ekibinin dokümanındadır: **MQTT Binary Protokolü v1, rev 1.0
(3 Kasım 2026)** → `firmware/MQTT-BINARY-PROTOKOL.html`. Bu not, bizim tarafta
nasıl uygulandığını ve uyulması gereken kuralları anlatır.

> **20.11.2026: JSON desteği kaldırıldı.** Backend yalnızca binary kabul eder
> ve yalnızca binary gönderir. JSON basan (eski) firmware'in verisi işlenmez,
> komut da alamaz; admin kartında "JSON gönderen cihaz" olarak listelenir.
> Bu cihazlar binary firmware'e güncellenmelidir.

## Akış

```
ESP32 ──binary──▶ Meven:<MAC>/bin ──▶ backend (+/bin aboneliği)
                                           │ lib/binproto: CRC + çözme + iç JSON'a çevirme
                                           ▼
                      iç JSON → routeUplink → handleD4i / handleHealth  (ack → handleAck)
```

- Cihaz **bütün uplink'ini** `Meven:<MAC>/bin`'e basar. `/data` ve
  `/health`'e gelen JSON (eski firmware) **işlenmez**: backend bu topic'lere
  yalnızca böyle cihazları admin kartında göstermek için abone olur
  (`noteRejectedJson`).
- Çözücü **backend'in içindedir** (TypeScript). Firmware ekibinin
  `scripts/mqtt_bridge.py` köprüsü ayrı servis olarak **çalıştırılmaz**;
  çevirme kuralları ondan birebir porte edildi (`src/lib/binproto/toJson.ts`).
- **Bütün komutlar binary** gider; cihaz `/bin`'e binary ack döner (bkz.
  "Komutlar").

## Komutlar (sunucu → cihaz)

Cihaz komutu (`Meven:<MAC>/cmd`, bakım ve zone dahil) ve `Meven:all/cmd`
aynı binary paketi alır. Bölge / alt grup / müşteri "Tüm Sistem"i
**cihaz başına `Meven:<MAC>/cmd`'ye** gider (aynı paket, aynı kısa id):
cihazlar `Meven:<slug>/cmd` topic'lerini dinlemez (firmware kararı, 2026-11).
Topic başına biçim seçimi ve `MQTT_BINARY_COMMANDS`
kapatma anahtarı 20.11.2026'da kaldırıldı.

- **Sınır:** eski (JSON) firmware'li bir cihaz binary komutu anlamaz (`gecersiz json` döner, o da işlenmez).
- `on`/`off` kabloda `dim 100/0`'dır. Tüm lambalar için kanal alanı yazılmaz
  (binary'de "broadcast"). Efekt durdurma kanalsız `dim` ile yapılır;
  `number 0` kullanılmaz.
- **Kısa id:** `COMMAND_ID` u16 (1–65535), UUID kabloya çıkmaz. Sayaç backend
  genelinde tektir, cihaz başına değil: bölge komutu tek id ile çok cihaza
  gider, cevaplar MAC topic'inden ayrılır. 1 bayt, 10 dk'lık eşleşme
  penceresinde dönebileceği için 2 bayt seçildi. Başlangıç rastgele.
  `src/lib/binproto/shortIds.ts`.
- **Binary ack:** id UUID'ye çevrilip `handleAck` ile işlenir
  (delivered/failed, rozet, arıza geçmişi, Bakım sekmesi). Eşlenemeyen ack
  (restart sonrası, süresi geçmiş, id'siz -15/-16/-17) bir komutu tahminle
  `failed` yapmaz; hata yine cihaz rozetine yazılır.
- **Bölge / alt grup / "Tüm Sistem" komutu cevaplıdır:** MAC topic'inden
  geldiği için her cihaz ack döner (aynı id). `ok` ilk gelende `commands`
  satırı `delivered`, herhangi bir cihaz hata verirse `failed`; hata o
  cihazın rozetine yazılır.
- **`Meven:all/cmd`'ye cevap yok** (firmware kararı): `commands` satırı
  cihazın sonraki telemetrisiyle `delivered` olur.

## Dinamik bölge aboneliği (zone komutları)

Firmware ekibinin "Dinamik zone ve bölgesel OTA" planı: cihaz dinlediği bölge
topic'lerini NVS'te tutar, backend `Meven:<MAC>/cmd`'ye binary komutla yönetir.

| Kod | Action | Alan | Etki |
|---|---|---|---|
| 6 | `zone_add` | 1-3 × `0xA9 COMMAND_ZONE` | ekle + abone ol |
| 7 | `zone_remove` | 1-3 × `0xA9` | çıkar + aboneliği bırak |
| 8 | `zone_clear` | — | hepsini sil (MAC + `all` kalır) |
| 9 | `zone_list` | — | ack listenin tamamını taşır |

- Yeni alanlar: `0xA9 COMMAND_ZONE` (metin, bir pakette tekrar edebilir),
  `0xAA COMMAND_ZONE_COUNT` (u8, komuttan sonra cihazdaki bölge sayısı; -14 ve
  -21'de yok). Sonuç kodları -18 `zone gecersiz`, -19 `zone siniri asildi`,
  -20 `zone kaydedilemedi`, -21 `zone komutu yalnizca cihaz topic'inden kabul edilir`.
- Ack JSON'u (köprüyle aynı): `{"action":"zone_list","id":16,"status":"ok","zone_count":2,"zones":[…]}`.
  Tekrar eden 0xA9 `frame.fields` dizisinden okunur (Map son değere iner).
- Backend tarafı: `src/lib/zoneSync/` (istenen durum ↔ cihazın listesi, cihaz
  başına tek uçuşta komut, HELLO'da doğrulama). Dokümandaki 9 örnek paket
  `npm run check:binproto`'da birebir sınanır. Ayrıntı: CLAUDE.md "Dinamik bölge aboneliği".

## Mesh rotası (health, 0xCE/0xCF)

| Kod | Ad | Boy | JSON |
|---|---|---|---|
| 0xCE | `THREAD_ROUTE_NEXT_HOP` | u16 | `thread.route_next_hop` — BR'ye giden ilk sıçramanın RLOC16'sı |
| 0xCF | `THREAD_ROUTE_PATH_COST` | u8 | `thread.route_path_cost` — BR'ye toplam yol maliyeti |

- Alanı göndermeyen (eski) firmware'de ikisi de `null`. Değerler ham yazılır;
  "rota yok" sentinel'leri (next hop 0xFFFE/0xFFFF, maliyet 0xFF) yalnızca
  `src/lib/mesh` topoloji kurucusunda yorumlanır.
- Adlar firmware `msg_fields.h` ile teyit edilmeli (JSON aynası / Python köprüsü aynı adı kullanır).
- Admin "Ağ haritası" rotaları bu iki alandan çizer (CLAUDE.md "Ağ haritası").
- Mock: `npm run mock:device <MAC> 2 <bölge> --rloc 0x5C00 --next-hop 0x0400 --cost 2 [--rssi -83]`.

## Kod

| Dosya | Görev |
|---|---|
| `src/lib/binproto/fields.ts` | Alan tablosu (142 alan) + enum'lar — `msg_fields.h`'nin kopyası |
| `src/lib/binproto/codec.ts` | CRC-16/CCITT-FALSE, `decodeFrame`, `encodeFrame` |
| `src/lib/binproto/toJson.ts` | Python `to_legacy` portu (d4i, health, ack, commission…) |
| `src/lib/binproto/espErr.ts` | OTA hata kodu → ESP-IDF adı |
| `src/lib/binproto/command.ts` | `encodeCommand` (TYPE = COMMAND) |
| `src/lib/binproto/shortIds.ts` | Kısa komut id'si ↔ UUID tablosu |
| `src/lib/binUplink.ts` | Sunucu katmanı: sayaçlar, alarm, health önbelleği, `binSeen`, JSON reddi |
| `src/lib/mqtt.ts` | `+/bin` aboneliği (QoS 2), `handleBinUplink` → `routeUplink`; `/data`/`/health` JSON reddi; binary `publishCommand` |
| `GET /api/admin/binproto` + `src/app/admin/BinaryProtocol.tsx` | Admin kartı |

## Kurallar

1. **Alan tablosu önce, OTA sonra.** Firmware yeni bir alan eklediğinde önce
   `src/lib/binproto/fields.ts` güncellenir, `npm run check:binproto` geçer,
   deploy edilir; ancak ondan sonra cihazlara OTA yapılır. Tanımsız alan taşıyan
   paket **tamamen atılır**: o cihazın verisi panelde görünmez, admin sayfasında
   kırmızı uyarı çıkar. Mevcut bir alanın kodu, boyu ya da anlamı değişmez;
   biçim değişirse versiyon baytı artar.
2. **Python köprüsü canlıda yalnızca salt-okur modlarda çalıştırılır**
   (`--watch`, `--compare`). Köprü modunda bastığı JSON işlenmez, yalnızca
   cihaz admin kartında "JSON gönderen" olarak görünür.
3. **JSON reddi:** `/data` ve `/health`'e gelen JSON hiçbir yere yazılmaz
   (`last_seen`, telemetri, ack, health). JSON yolu geri eklenmez; binary'de
   karşılığı olmayan bir ihtiyaç çıkarsa alan tablosu genişletilir.
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

## JSON aynası (izleme)

Railway'de `MQTT_JSON_MIRROR=all` (ya da `MQTT_JSON_MIRROR=D40592FFFEA8,…`)
verilirse backend çözdüğü her paketin JSON'unu yeniden basar. Python
köprüsünün `--watch --json` çıktısıyla aynıdır:

| Topic | İçerik |
|---|---|
| `Meven:<MAC>/json/health` | health JSON'u |
| `Meven:<MAC>/json/data` | d4i_periodic, komut ack'i (u16 id), HELLO (`data` metni) |
| `Meven:<MAC>/json/reject` | `{reason, detail, hex}`: CRC, tanımsız alan, eksik alan… |

İzlemek için `+/json/#` ya da `Meven:<MAC>/json/#`. Varsayılan kapalıdır
(broker trafiği). Backend'in ürettiği bir izleme akışıdır, cihazdan JSON
almak değildir. Topic bilerek `/data` ve `/health` değil: backend bunları
dinler, kendi aynasını "JSON gönderen cihaz" sayardı.

## Test

- `npm run check:binproto`: dokümandaki CRC kontrol değerleri ve 6 örnek
  paket, Python `selftest` beklentileri, ret durumları, şema uyumu (`parseUplink`,
  `deviceHealthSchema`, `activeFaultCodes`).
- `npm run mock:device <MAC> <kanal> <bölge>`: sanal cihaz binary basar
  (d4i_periodic, health, HELLO), binary komuta binary ack döner. `--json`
  eski firmware'i taklit eder (JSON basar, binary komuta `gecersiz json`):
  yalnızca admin kartındaki "JSON gönderen cihaz" uyarısını denemek için.
- `npm run watch:cmd [MAC]`: backend'in bastığı komutları gösterir; binary
  komutu hex + çözülmüş haliyle yazar, JSON komut görürse hata basar.
- `npm run mock:bin <MAC> <hex…>` / `--ornek d4i|dali|health|ack|crc|alan|lora`:
  yakalanan paketleri yeniden oynatır. Yerel olmayan broker'da `--canli`
  ister; canlıya basılan paket gerçek veri gibi işlenir.

## Devreye alma (tamamlandı)

Aşağıdaki geçiş sırası binary'ye geçişte izlendi; 20.11.2026'da JSON desteği
kaldırıldı. Yeni bir firmware sürümünde de aynı sıra geçerlidir.

1. Backend deploy edilir.
2. **Tek test cihazına** OTA yapılır (Kural #17).
   - `python mqtt_bridge.py --watch <MAC> --json` (salt-okur) ile referans
     JSON izlenir.
   - Panelde kontrol: lambalar, D4i paneli, güç/enerji özeti, arızalar,
     Bakım sekmesi, komut + ack. `npm run watch:cmd <MAC>` ile komutun
     binary gittiği görülür (cihazın ilk raporundan sonra).
   - Admin kartı ret göstermemeli.
3. Filoya kademeli OTA, cihaz cihaz.

## Sonraki fazlar

- **Cihazdaki JSON komut desteği** kaldırılabilir (firmware ekibiyle):
  backend artık hiç JSON komut göndermiyor.
- **LoRa gateway protokolü (0x02):** `lora_protocol.py` ve dokümanı bekleniyor.
- Firmware ekibinden `msg_codec.py` ve `esp_err_names.py` gelirse, sahadan
  yakalanan paketlerle Python ↔ TS altın veri testi eklenir.
