# Border Router binary protokolu (paket versiyonu 0x03)

> Firmware ekibinin cevabı (Kasım 2026), olduğu gibi. Backend'deki kopyası:
> `src/lib/binproto/brFields.ts` (alan tablosu), `brToJson.ts` (JSON'a
> çevirme), `brTopology.ts` (sayfa birleştirme). Örnek paketler
> `npm run check:binproto` içinde sınanır. Backend entegrasyonu:
> `GATEWAY-ENTEGRASYON.md`.

Lamba (0x01) tarafinin sorularina cevap. Kaynak dosyalar:
`components/br_codec/include/msg_fields.h`, `components/br_codec/src/msg_fields.c`,
`main/br_telemetry.c`, `components/br_mqtt/br_mqtt.c`. Ayrintili dokuman:
`docs/MQTT_BR_TELEMETRI.md`.

---

## 1. Alan tablosu

Lambadaki `msg_fields.h`'nin karsiligi ayni isimde:
`components/br_codec/include/msg_fields.h` (boylar `src/msg_fields.c`).

- Lambayla ayni anlamdaki alanlar ayni koddadir: TYPE `0x01`, komut
  `0xA0`/`0xA1`/`0xA6`, health `0xB0-0xBA`, thread `0xC0-0xCD`, OTA `0xE0-0xEB`.
- Cok bayt degerler **little-endian**.
- Isaretli (ikiye tumleyen) alanlar yalnizca: `WIFI_RSSI`, `NB_RSSI_AVG`,
  `NB_RSSI_LAST`, `COMMAND_RESULT`, `OTA_LAST_ERROR`.
- Degisken boylu alan: once 1 bayt uzunluk, sonra veri.
- Tabloda olmayan alan iceren paket reddedilir.

### 1.1 Ortak ve sayfalama

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0x01 | TYPE | 1 | u8 | mesaj tipi |
| 0x02 | SNAPSHOT_ID | 2 | u16 | ayni topoloji turundaki sayfalari gruplar |
| 0x03 | PAGE | 1 | u8 | 0'dan baslar |
| 0x04 | LAST_PAGE | 1 | u8 | 1 ise son sayfa; sayfanin son alani |
| 0x05 | TOTAL | 1 | u8 | listedeki toplam kayit |

### 1.2 Wi-Fi

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0x10 | WIFI_CONNECTED | 1 | u8 | AP'ye bagli ve IPv4 var |
| 0x11 | WIFI_RSSI | 1 | i8 | dBm; bagli degilse yok |
| 0x12 | WIFI_CHANNEL | 1 | u8 | AP kanali |
| 0x13 | WIFI_DISCONNECTS | 4 | u32 | acilistan beri kopma (roaming haric) |
| 0x14 | WIFI_LAST_DISCONNECT_REASON | 1 | u8 | `wifi_err_reason_t`; hic kopmadiysa yok |
| 0x15 | WIFI_BEACON_TIMEOUTS | 4 | u32 | acilistan beri |
| 0x16 | WIFI_CONNECTED_S | 4 | u32 | son IPv4 alinindan beri saniye |

### 1.3 Thread agi (leader gozuyle)

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0x20 | LEADER_ROUTER_ID | 1 | u8 | yalnizca bagliyken |
| 0x21 | ROUTER_COUNT | 1 | u8 | agdaki router sayisi |
| 0x22 | CHILD_COUNT | 1 | u8 | gateway'in kendi child'lari |
| 0x23 | NEIGHBOR_COUNT | 1 | u8 | dogrudan komsu (router + child) |
| 0x24 | NETDATA_VERSION | 1 | u8 | yalnizca bagliyken |
| 0x25 | STABLE_NETDATA_VERSION | 1 | u8 | yalnizca bagliyken |
| 0x26 | DETACHED_COUNT | 2 | u16 | agdan kopma sayisi |
| 0x27 | LEADER_COUNT | 2 | u16 | leader olma sayisi |
| 0x28 | BORDER_ROUTING_STATE | 1 | u8 | 0 uninit, 1 disabled, 2 stopped, 3 running |
| 0x29 | BORDER_AGENT_ACTIVE | 1 | u8 | 0/1 |
| 0x2A | CCA_FAILURE_RATE | 2 | u16 | kanal mesgul orani, 0xFFFF = %100 |

### 1.4 Sayaclar

Hepsi 4 bayt u32, **son basarili BR_HEALTH'ten bu yana fark**. Acilistan
sonraki ilk paket acilistan beri toplami tasir.

| Kod | Alan |
|---|---|
| 0x30 | MAC_TX_TOTAL |
| 0x31 | MAC_TX_UNICAST |
| 0x32 | MAC_TX_ACK_REQUESTED |
| 0x33 | MAC_TX_ACKED |
| 0x34 | MAC_TX_RETRY |
| 0x35 | MAC_TX_ERR_CCA |
| 0x36 | MAC_TX_ERR_ABORT |
| 0x37 | MAC_TX_ERR_BUSY_CHANNEL |
| 0x38 | MAC_RX_TOTAL |
| 0x39 | MAC_RX_DUPLICATED |
| 0x3A | MAC_RX_ERR_FCS |
| 0x3B | MAC_RX_ERR_SEC |
| 0x3C | MAC_RX_ERR_NO_FRAME |
| 0x3D | MAC_RX_ERR_UNKNOWN_NEIGHBOR |
| 0x3E | MAC_RX_ERR_OTHER |
| 0x3F | COUNTERS_PERIOD_S (farkin kapsadigi sure, saniye) |
| 0x40 | IP_TX_SUCCESS |
| 0x41 | IP_TX_FAILURE |
| 0x42 | IP_RX_SUCCESS |
| 0x43 | IP_RX_FAILURE |

### 1.5 Komsu kaydi (BR_NEIGHBORS)

Her `NB_RLOC16` yeni kayit baslatir; sonraki `NB_*` alanlari o kayda aittir.

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0x60 | NB_RLOC16 | 2 | u16 | `router_id = rloc16 >> 10` |
| 0x61 | NB_EXT_ADDR | degisken (8) | bayt | ext adres, RLOC16 degisse de sabit |
| 0x62 | NB_IS_CHILD | 1 | u8 | 1 child, 0 router |
| 0x63 | NB_RSSI_AVG | 1 | i8 | dBm, gateway'in duydugu ortalama |
| 0x64 | NB_RSSI_LAST | 1 | i8 | dBm |
| 0x65 | NB_LINK_MARGIN | 1 | u8 | dB |
| 0x66 | NB_LQ_IN | 1 | u8 | 0..3 |
| 0x67 | NB_LQ_OUT | 1 | u8 | 0..3, yalnizca router |
| 0x68 | NB_AGE_S | 2 | u16 | son duyulmadan beri, 65535'te doyar |
| 0x69 | NB_FRAME_ERROR_RATE | 2 | u16 | 0xFFFF = %100 |
| 0x6A | NB_MESSAGE_ERROR_RATE | 2 | u16 | 0xFFFF = %100 |
| 0x6B | NB_THREAD_VERSION | 1 | u8 | |

### 1.6 Router kaydi (BR_ROUTES)

Her `RT_ROUTER_ID` yeni kayit baslatir.

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0x70 | RT_ROUTER_ID | 1 | u8 | |
| 0x71 | RT_RLOC16 | 2 | u16 | |
| 0x72 | RT_NEXT_HOP | 1 | u8 | router id; 63 = yol yok / gateway'in kendisi |
| 0x73 | RT_PATH_COST | 1 | u8 | |
| 0x74 | RT_LQ_IN | 1 | u8 | |
| 0x75 | RT_LQ_OUT | 1 | u8 | |
| 0x76 | RT_AGE_S | 1 | u8 | |
| 0x77 | RT_LINK_ESTABLISHED | 1 | u8 | 0/1, dogrudan komsu |

### 1.7 Komut ve ack

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0xA0 | COMMAND_ACTION | 1 | u8 | 5 `ota_check`, 6 `report_now` |
| 0xA1 | COMMAND_ID | 2 | u16 | istege bagli, ack'te aynen doner |
| 0xA6 | COMMAND_RESULT | 1 | i8 | 0 ok, -2 action yok, -5 bilinmeyen action, -12 OTA hazir degil, -15 CRC, -16 versiyon, -17 bicim bozuk |

### 1.8 Health

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0xB0 | HEALTH_UPTIME_S | 4 | u32 | |
| 0xB1 | HEALTH_FREE_HEAP_BYTES | 4 | u32 | |
| 0xB2 | HEALTH_FIRMWARE_VERSION | 3 | u24 | `major<<16 \| minor<<8 \| patch` |
| 0xB3 | HEALTH_IDF_VERSION | 3 | u24 | ayni bicim; baglanti basina bir kez |
| 0xB4 | HEALTH_BUILD_TIMESTAMP | 4 | u32 | `__DATE__ __TIME__`, 1970'ten beri saniye; baglanti basina bir kez |
| 0xB5 | HEALTH_MIN_FREE_HEAP_BYTES | 4 | u32 | acilistan beri en dusuk |
| 0xB6 | HEALTH_RESET_REASON | 1 | u8 | lambadaki `msg_reset_reason_t` ile ayni |
| 0xB7 | HEALTH_MQTT_CONNECTS | 2 | u16 | acilistan beri broker baglantisi |
| 0xB8 | HEALTH_MQTT_PUBLISH_FAILS | 4 | u32 | acilistan beri |
| 0xB9 | HEALTH_INTERVAL_S | 4 | u32 | baglanti basina bir kez |
| 0xBA | HEALTH_TOPOLOGY_INTERVAL_S | 4 | u32 | baglanti basina bir kez |

### 1.9 Gateway'in Thread durumu

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0xC0 | THREAD_ROLE | 1 | u8 | 0 disabled, 1 detached, 2 child, 3 router, 4 leader |
| 0xC6 | THREAD_RLOC16 | 2 | u16 | |
| 0xC7 | THREAD_PARTITION_ID | 4 | u32 | |
| 0xC8 | THREAD_CHANNEL | 1 | u8 | |
| 0xC9 | THREAD_PAN_ID | 2 | u16 | |
| 0xCA | THREAD_NETWORK_NAME | degisken | metin | baglanti basina bir kez |
| 0xCC | THREAD_PARTITION_ID_CHANGES | 2 | u16 | |
| 0xCD | THREAD_ATTACH_ATTEMPTS | 2 | u16 | |

### 1.10 OTA

| Kod | Alan | Bayt | Tip | Anlami |
|---|---|---|---|---|
| 0xE0 | OTA_STATE | 1 | u8 | lambayla ayni enum |
| 0xE1 | OTA_LAST_RESULT | 1 | u8 | lambayla ayni enum |
| 0xE2 | OTA_BUSY | 1 | u8 | |
| 0xE3 | OTA_CHECK_COUNT | 4 | u32 | |
| 0xE4 | OTA_LAST_CHECK_UPTIME_S | 4 | u32 | |
| 0xE5 | OTA_LAST_SUCCESS_UPTIME_S | 4 | u32 | |
| 0xE6 | OTA_LAST_TARGET_VERSION | 3 | u24 | |
| 0xEB | OTA_LAST_ERROR | 4 | i32 | `esp_err_t`, yalnizca hata varken |

---

## 2. Mesaj tipleri ve zorunlu alanlar

BR'de `hello` ve `data` tipi **yok**. `/data` yalnizca koprunun ack JSON'unu
bastigi topic'tir.

| TYPE | Tip | Yon | Ne zaman |
|---|---|---|---|
| 0x05 | BR_HEALTH | cihaz -> sunucu | baglaninca hemen, sonra 300 sn'de bir |
| 0x06 | COMMAND_ACK | cihaz -> sunucu | her komuta |
| 0x08 | COMMAND | sunucu -> cihaz | |
| 0x09 | BR_NEIGHBORS | cihaz -> sunucu | baglaninca, sonra 900 sn'de bir; sayfali |
| 0x0A | BR_ROUTES | cihaz -> sunucu | NEIGHBORS'tan hemen sonra, ayni SNAPSHOT_ID ile |

Codec duzeyinde zorunlu tek alan **TYPE**'tir ve ilk alan olmak zorundadir.
Diger alanlari istege bagli kabul edin; eksik alan JSON'da `null` olur.
Firmware'in fiilen yazdiklari:

**BR_HEALTH**
- Her pakette: B0, B1, B5, B6, B7, B8; 10, 13, 15; C0, C6, C7, C8, C9, CC, CD;
  21, 22, 23, 26, 27, 28, 29, 2A; tum sayaclar (30-3F, 40-43).
- MQTT baglantisi basina bir kez (baglantidan sonraki ilk health): B3, B4, B9, BA, CA.
- Kosullu:
  - B2: versiyon okunabildiyse
  - 11, 12: AP'ye bagliyken
  - 16: IPv4 varken
  - 14: en az bir kez koptuysa
  - 20, 24, 25: Thread'e bagliyken
  - E0-E5: OTA durumu okunabildiyse
  - E6: hedef versiyon varsa
  - EB: OTA hatasi varsa

**BR_NEIGHBORS**: 02, 03, 05, ardindan kayitlar, en sonda 04. Her kayitta
60, 61, 62, 65, 66, 68, 69, 6A, 6B var; 63/64 RSSI gecerliyse, 67 yalnizca
router komsuda.

**BR_ROUTES**: 02, 03, 05, kayitlar (her kayitta 70-77 hepsi), en sonda 04.

**COMMAND**: A0 zorunlu, A1 istege bagli.

**COMMAND_ACK**: A6 her zaman; A0 ve A1 komutta geldiyse geri doner. Bozuk
komutta yalnizca A6.

---

## 3. Topic ve CRC

| Yon | Topic | QoS |
|---|---|---|
| cihaz -> sunucu | `Meven:<MAC>/bin` | 1 |
| sunucu -> cihaz | `Meven:<MAC>/cmd` | - |
| cihaz -> sunucu | `Meven:<MAC>/lwt` (retained `{"online":true/false}`) | 1 |

- `<MAC>`: C3'un Wi-Fi STA MAC'i, 12 buyuk harf hex, ayracsiz; lambalarla ayni bicim.
- Gateway `Meven:all/cmd`'ye ve bolge topic'lerine abone olmaz.
- CRC 0x01 ile **birebir ayni**: CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF,
  refin/refout yok, xorout 0). Versiyon bayti dahil CRC'den onceki her sey
  uzerinden hesaplanir, sona little-endian (once alt bayt) yazilir.
  `"123456789"` icin `0x29B1`.
- Paket en fazla 512 bayt.

Paket bicimi:

```
[0x03] [0x01 TYPE] [tip] [alan][deger] ... [CRC16 alt][CRC16 ust]
```

---

## 4. Test paketleri

Codec ile uretilip decode edilerek dogrulandi (C tablosuyla selftest gecti).
Sahadan yakalanmis paket degildir; gercek paketler icin firmware'de
`CONFIG_BR_MQTT_BIN_LOG=y` her paketi hex loglar.

### COMMAND - report_now, id 7

```
03 01 08 A0 06 A1 07 00 AE 52
```

### COMMAND_ACK - ok

```
03 01 06 A0 06 A1 07 00 A6 00 30 15
```

| Bayt | Anlami |
|---|---|
| `03` | versiyon |
| `01 06` | TYPE = COMMAND_ACK |
| `A0 06` | COMMAND_ACTION = report_now |
| `A1 07 00` | COMMAND_ID = 7 |
| `A6 00` | COMMAND_RESULT = 0 (ok) |
| `30 15` | CRC = 0x1530 |

### BR_NEIGHBORS - snapshot 12, tek router komsu (rloc 0x0800, RSSI -61)

```
03 01 09 02 0C 00 03 00 05 01 60 00 08 61 08 1A 2B 3C 4D 5E 6F 70 81 62 00 63 C3 64 C1 65 23 66 03 67 03 68 04 00 69 48 01 6A 00 00 6B 04 04 01 E9 95
```

### BR_ROUTES - iki router (leader'in kendisi ve router 2)

```
03 01 0A 02 0C 00 03 00 05 02 70 01 71 00 04 72 3F 73 00 74 00 75 00 76 00 77 00 70 02 71 00 08 72 02 73 01 74 03 75 03 76 05 77 01 04 01 DB 5A
```

### BR_HEALTH - baglantidan sonraki ilk paket (248 bayt)

fw 1.2.0, IDF v6.0, rol leader, Wi-Fi -58 dBm kanal 6, network "Meven".

```
03 01 05 B0 10 0E 00 00 B1 48 EE 00 00 B5 10 A4 00 00 B2 00 02 01 B3 00 00 06 B4 40 93 FD 6A B9 2C 01 00 00 BA 84 03 00 00 B6 01 B7 01 00 B8 00 00 00 00 10 01 11 C6 12 06 16 06 0E 00 00 13 00 00 00 00 15 00 00 00 00 C0 04 C6 00 04 C7 78 56 34 12 C8 0F C9 34 12 CA 05 4D 65 76 65 6E CC 01 00 CD 01 00 20 01 24 05 25 03 21 03 22 00 23 02 26 01 00 27 01 00 28 03 29 01 2A 12 03 3F 10 0E 00 00 30 C8 00 00 00 31 96 00 00 00 32 96 00 00 00 33 93 00 00 00 34 0A 00 00 00 35 02 00 00 00 36 00 00 00 00 37 00 00 00 00 38 90 01 00 00 39 01 00 00 00 3A 03 00 00 00 3B 00 00 00 00 3C 00 00 00 00 3D 05 00 00 00 3E 00 00 00 00 40 63 00 00 00 41 01 00 00 00 42 B4 00 00 00 43 00 00 00 00 E0 00 E1 00 E2 00 E3 01 00 00 00 E4 1E 00 00 00 E5 00 00 00 00 9D EA
```

Referans cozucuyle kontrol:

```
python br_protocol.py decode 03 01 06 A0 06 A1 07 00 A6 00 30 15
```
