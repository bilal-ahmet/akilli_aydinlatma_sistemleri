# Gateway entegrasyonu (MQTT kontratı)

Sahadaki gateway'ler (Thread Border Router, 4G/WiFi router, ileride LoRaWAN
gateway) backend'e cihazlarla **aynı topic şemasıyla** bağlanır. Bu belge
gateway firmware'inin uyması gereken kontratı tanımlar. Cihaz (ESP32 lamba
kontrolcüsü) kontratı için: `ESP32-ENTEGRASYON.md`.

## 1) Topic'ler

| Topic | Yön | Ne |
|---|---|---|
| `Meven:<GW_ID>/health` | gateway → backend | ~30 sn'de bir ortak bilgiler (zarf). LWT de buraya. |
| `Meven:<GW_ID>/data`   | gateway → backend | ~30 sn'de bir türe özgü bilgi + bağlı cihaz listesi. |
| `Meven:<GW_ID>/cmd`    | backend → gateway | Gateway komutları (henüz tanımlı komut yok, topic ayrıldı). |

- **GW_ID** = gateway'in MAC adresi, iki noktasız, büyük harf (örn. `A1B2C3D4E5F6`).
- QoS: health/data publish → 0 · cmd subscribe → 1.

## 2) İki zorunlu kural

1. **Her mesajda (`/health`, `/data`, LWT) `"type"` alanı olmalı:**
   `thread_br` | `cellular` | `wifi` | `lorawan`.
   Topic'ler cihazlarla ortak olduğu için backend gateway'i lambadan
   **yalnızca bu alanla** ayırır. Alan unutulursa ve gateway henüz panelde
   kayıtlı değilse, mesaj lamba mesajı sanılıp atılır.
2. **Gateway yalnızca kendi `Meven:<GW_ID>/cmd` topic'ine abone olur.**
   `Meven:all/cmd` ve bölge topic'lerine (`Meven:<bölge>/cmd`) abone OLMAZ.
   Bunlar lambalara gider ("Tüm Sistem", acil durum komutu).

## 3) `/health` — ortak zarf (~30 sn)

```json
{
  "type": "thread_br",
  "fw": "0.1.0",
  "uptime_s": 12345,
  "online": true,
  "uplink": { "kind": "ethernet", "rssi": -67, "ip": "10.0.0.5" }
}
```

- `uplink.kind`: `ethernet` | `wifi` | `cellular` (gateway'in internete çıkışı). `uplink` opsiyonel.
- **LWT** (MQTT bağlantısında `will` olarak ayarlanır; bağlantı koparsa
  broker yayınlar): topic `Meven:<GW_ID>/health`, payload
  `{"type":"thread_br","online":false}`, retain yok. Panel gateway'i
  2 dakika beklemeden "Bağlantı yok" gösterir.

## 4) `/data` — türe özgü blok + bağlı cihazlar (~30 sn)

```json
{
  "type": "thread_br",
  "thread": {
    "role": "leader", "network_name": "fener-1", "channel": 15,
    "pan_id": "0x1234", "ext_pan_id": "dead00beef00cafe",
    "router_count": 2, "child_count": 12
  },
  "nodes": [ { "mac": "A842E3123456", "rssi": -70 } ]
}
```

- Blok anahtarı türe göre değişir: `thread`, `cellular`, `wifi`, `lorawan`.
  İçerik serbesttir. Panelde etiketli gösterilen alanlar aşağıda; ek alanlar
  kaybolmaz, yönetici panelinde ham haliyle görünür.

| Tür | Blok | Etiketli alanlar |
|---|---|---|
| `thread_br` | `thread` | `role`, `network_name`, `channel`, `pan_id`, `ext_pan_id`, `partition_id`, `router_count`, `child_count` |
| `cellular` | `cellular` | `operator`, `network`, `rssi`, `rsrp`, `iccid` |
| `wifi` | `wifi` | `ssid`, `rssi`, `clients` |
| `lorawan` | `lorawan` | `gateway_eui`, `frequency_plan`, `rx_packets`, `tx_packets` |

- **`nodes`** (opsiyonel): gateway'e bağlı lamba kontrolcüleri. `mac`,
  ESP32'nin **WiFi MAC'i** olmalı (cihazın topic'lerinde kullandığı kimlik,
  Thread EUI-64 değil). Liste yetkilidir: listede olmayan cihazın bu gateway'e
  bağı kaldırılır. Liste hiç gönderilmezse mevcut bağlar korunur.
- `nodes` verilemiyorsa alternatif: lamba kontrolcüsü kendi
  `Meven:<MAC>/health` mesajına `"gateway": "<GW_ID>"` ekler.

## 5) Backend davranışı

- Panelde **kayıtlı olmayan** bir GW_ID'nin verisi saklanmaz. Kimlik yönetim
  ekranındaki "Keşfedilen ağ geçitleri" listesinde görünür ve oradan bir
  müşteriye kaydedilir.
- Kayıtlı gateway'de her mesaj tek satırı günceller (geçmiş tutulmaz): son
  health, son data, firmware sürümü, son görülme.
- Aynı MAC hem cihaz hem gateway olarak kaydedilemez.

## 6) Donanımsız test

```
npm run mock:gateway A1B2C3D4E5F6 thread_br A842E3123456
```

Sanal gateway health + data basar, LWT kurar ve `nodes` içine verilen
MAC'leri koyar. Ctrl+C bağlantıyı koparır ve LWT tetiklenir.
