# Mock ESP32 — Entegrasyon Testi (HiveMQ Cloud)

ESP32 olmadan uçtan uca akışı doğrulamak için iki yol var:

1. **`npm run mock:device`** — Node tabanlı sanal cihaz (`scripts/mock-device.ts`).
   Komutları uygular ve durum yayınlar; tek-lamba veya çok-lamba (DALI kanal) modu.
2. **`mosquitto_pub`/`mosquitto_sub`** — ham MQTT ile elle test (aşağıda).

> Topic şeması **MAC tabanlı** (ESP ekibi kontratı, `src/lib/topics.ts`):
> `Meven:<MAC>/cmd` (komut, backend→cihaz), `Meven:<MAC>/data` (veri, cihaz→backend),
> `Meven:all/cmd` (toplu). MAC iki noktasız/büyük harf (örn. `A842E3123456`).
> TLS zorunlu (port **8883**). `<HOST> <USER> <PASS>` yerine HiveMQ bilgilerini koy.

---

## A) Sanal cihaz (önerilen)

```bash
npm run mock:device                    # tek lamba, MAC A842E3123456
npm run mock:device A842E3123456 3     # 3 DALI kanallı (çok-lamba) cihaz
```

Dashboard → **Cihazlar** → cihaza tıkla → kontrol paneli açılır. Cihaz-seviyesi
(tüm ESP) ya da tek lamba (kanal) aç/kapa · dim · efekt gönder → mock konsolunda
komut görünür, `data` yayınlanır, panel canlı (SSE) güncellenir.

---

## B) Ham MQTT ile elle test

### 1) Backend'in gönderdiği komutları dinle

```bash
mosquitto_sub -h <HOST> -p 8883 -u <USER> -P <PASS> --capath /etc/ssl/certs \
  -t 'Meven:A842E3123456/cmd' -t 'Meven:all/cmd' -v
```

- **Cihaz komutu** (tüm ESP): `{"action":"off"}`
- **Tek lamba** (kanal 3): `{"action":"dim","value":75,"channel":3}`
- **Efekt** (kanal 1): `{"action":"efekt","number":10,"channel":1}`
- `channel` yoksa komut tüm cihazı (bütün lambaları) etkiler.

### 2) Sahte cihaz verisi yayınla (ESP32 taklidi)

**Tek lamba (legacy):**

```bash
mosquitto_pub -h <HOST> -p 8883 -u <USER> -P <PASS> --capath /etc/ssl/certs \
  -t 'Meven:A842E3123456/data' \
  -m '{"deviceId":"A842E3123456","brightness":75,"relayStatus":"on","temperature":42,"rssi":-67,"status":"ok"}'
```

**Çok-lamba (DALI kanalları):**

```bash
mosquitto_pub -h <HOST> -p 8883 -u <USER> -P <PASS> --capath /etc/ssl/certs \
  -t 'Meven:A842E3123456/data' \
  -m '{"deviceId":"A842E3123456","temperature":42,"rssi":-67,"status":"ok","channels":[{"ch":0,"brightness":45,"relayStatus":"on"},{"ch":1,"brightness":80,"relayStatus":"on"},{"ch":2,"brightness":0,"relayStatus":"off"}]}'
```

Beklenen:
- Her kanal `fixtures` tablosuna **upsert** olur (deviceId + channel benzersiz).
- Cihaz kontrol panelinde lambalar **anında** güncellenir (SSE, kanal bazlı event).
- Bölge snapshot'ı kanallardan türetilen cihaz-seviyesi agregata göre rafine olur
  (açık kanal varsa `isOn`, parlaklık açık kanalların ortalaması).
- `devices.last_seen` güncellenir; bekleyen komutlar `delivered` olur.

### 3) Hata durumu

`"status":"error"` (veya bir kanalda `"status":"error"`) gönder → ilgili
lamba/bölge rozeti `fault`/`arıza` olur.

---

## Topic hiyerarşisi (özet)

| Topic | Yön | Not |
|---|---|---|
| `Meven:<MAC>/cmd` | Backend → ESP32 | `channel` ile tek lamba, yoksa tüm cihaz |
| `Meven:all/cmd` | Backend → tüm ESP32 | toplu komut |
| `Meven:<MAC>/data` | ESP32 → Backend | `channels[]` ile çok-lamba, yoksa tek lamba |
