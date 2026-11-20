# Gateway entegrasyonu (MQTT kontratı)

Sahadaki ağ geçitleri (Thread Border Router; ileride 4G/WiFi router, LoRaWAN
gateway) backend'e lambalarla **aynı topic şemasıyla** bağlanır ve verilerini
**yalnızca binary** gönderir. Paketin ilk baytı **0x03**'tür (lamba 0x01);
backend ikisini bu baytla ayırır. Alan tablosu, mesaj tipleri ve örnek
paketler: **`BR-BINARY-PROTOKOL.md`** (firmware ekibinin belgesi). Lamba
kontratı: `ESP32-ENTEGRASYON.md`, `BINARY-ENTEGRASYON.md`.

> JSON gateway kontratı (`/health` + `/data` içinde `"type":"thread_br"`)
> **kaldırıldı**. Kayıtlı bir ağ geçidi kimliğinden gelen JSON ve lamba (0x01)
> paketi atılır.

## 1) Topic'ler

| Topic | Yön | Ne |
|---|---|---|
| `Meven:<GW_ID>/bin` | gateway → backend (QoS 2) | 0x03 paketleri: BR_HEALTH, BR_NEIGHBORS, BR_ROUTES, COMMAND_ACK |
| `Meven:<GW_ID>/lwt` | gateway → backend (QoS 2, **retained**) | `{"online":true}` bağlanınca, MQTT will ile `{"online":false}` |
| `Meven:<GW_ID>/cmd` | backend → gateway | 0x03 COMMAND: `report_now` (6), `ota_check` (5) |

- **GW_ID** = gateway'in Wi-Fi STA MAC'i, iki noktasız, büyük harf (örn.
  `404CCA544698`). `Meven:` öneki topic'in parçasıdır, kimliğe dahil değildir:
  panele `404CCA544698` yazılır.
- Gateway yalnızca kendi `Meven:<GW_ID>/cmd` topic'ine abone olur.
  `Meven:all/cmd` ve bölge topic'leri (`Meven:<bölge>/cmd`) lambalarındır.

## 2) Backend ne yapar

| Mesaj | Backend |
|---|---|
| BR_HEALTH (bağlanınca + ~300 sn) | `gateways.health` (son durum), `firmware_version`, `last_seen`, `online`. Bağlantı başına bir kez gelen alanlar (IDF, derleme, aralıklar, ağ adı) bellekte tutulup her health'e eklenir. Lamba bağı güncellenir (bkz. §4). |
| BR_NEIGHBORS / BR_ROUTES (bağlanınca + ~900 sn, sayfalı) | Aynı `SNAPSHOT_ID`'li sayfalar toplanır; tur tamamlanınca `gateways.report.neighbors` / `.routes`. Tekrarlanan sayfa bir kez sayılır, 2 dk'da tamamlanmayan tur atılır. |
| COMMAND_ACK | u16 id komutun UUID'sine çevrilir; `commands` satırı `delivered` / `failed`, panelde butonun altında sonuç. |
| `/lwt` | `online` güncellenir; `last_seen` ilerlemez. |

- **Kayıtsız GW_ID**: veri saklanmaz; 0x03 paketi geldiği için tür kesindir ve
  yönetim ekranındaki **"Keşfedilen ağ geçitleri"** listesine `thread_br`
  olarak düşer (son 24 saat). Oradan bir müşteriye kaydedilir.
- **Çevrimiçi**: LWT `online:false` değilse ve son haber
  `max(2 dk, 2,5 × health aralığı)` içindeyse. 300 sn'lik aralıkta 12,5 dk.
- Tanımsız alan kodu taşıyan paket tamamen atılır ve admin'in "Binary protokol"
  kartında kırmızı alarm çıkar. **Firmware yeni alan eklerse önce backend'deki
  `src/lib/binproto/brFields.ts` güncellenip deploy edilir, sonra OTA.**
- Aynı MAC hem cihaz (lamba) hem gateway olarak kaydedilemez.

## 3) Komutlar

`POST /api/gateways/<GW_ID>/command` `{ "action": "report_now" | "ota_check" }`

- `report_now`: admin + müşteri yöneticisi. Gateway beklemeden health ve
  topoloji gönderir.
- `ota_check`: yalnızca admin. Gateway güncellemedeyse ya da son 3 dk içinde
  istek aldıysa ve bitirdiğini bildirmediyse 409.
- Yanıt kodları (COMMAND_RESULT): 0 ok, -2 action yok, -5 bilinmeyen action,
  -12 OTA hazır değil, -15 CRC, -16 versiyon, -17 biçim bozuk.

## 4) Lamba ↔ gateway bağı

0x03'te bağlı cihaz listesi (`nodes`) yok. Backend bağı **Thread partition**
eşleşmesiyle kurar: gateway health'indeki `THREAD_PARTITION_ID` ile lambanın
binary health'indeki `THREAD_PARTITION_ID` aynıysa (ve lamba gateway'in
müşterisine aitse) lamba o gateway'e bağlı sayılır. Admin topoloji tablosunda
komşu/router satırları lambaların `THREAD_RLOC16`'sıyla adlandırılır.

## 5) Donanımsız test

```
npm run mock:gateway 404CCA544698 --partition 305419896 --interval 30
npm run mock:device A842E3123456 2 <bölge> --partition 305419896 --rloc 23553
```

Sanal gateway 0x03 BR_HEALTH / BR_NEIGHBORS (iki sayfa) / BR_ROUTES basar,
`/lwt`'yi retained kurar ve `report_now` / `ota_check` komutlarına ack döner.
Ctrl+C bağlantıyı koparır, broker will'i (`online:false`) yayınlar. Yerel
olmayan broker'da `--canli` bayrağı olmadan çalışmaz. Sahadan yakalanan paket
`npm run mock:bin <GW_ID> <hex…>` ile yeniden oynatılabilir.
