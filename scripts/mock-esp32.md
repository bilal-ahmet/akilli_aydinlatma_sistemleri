# Mock ESP32 — Entegrasyon Testi (HiveMQ Cloud)

ESP32 olmadan uçtan uca akışı doğrulamak için `mosquitto_pub`/`mosquitto_sub`
ile HiveMQ Cloud broker'ına bağlanırız. TLS zorunlu (port **8883**).

> `<HOST> <USER> <PASS>` yerine HiveMQ Cloud bilgilerini koy. Windows'ta
> `--capath` yerine `--cafile` ile bir CA bundle verebilir veya HiveMQ Cloud
> **web client** (tarayıcı) kullanabilirsin.

## 1) Backend'in gönderdiği zone komutlarını dinle

```bash
mosquitto_sub -h <HOST> -p 8883 -u <USER> -P <PASS> --capath /etc/ssl/certs \
  -t 'city/lighting/zone/+/command' -v
```

Dashboard'dan bir zone'u aç/kapat → burada şuna benzer JSON görünmeli:

```json
{"action":"off","zoneId":"ataturk-bulvari","requestId":"…","timestamp":"…"}
```

## 2) Sahte cihaz status'u yayınla (ESP32 taklidi)

Cihaz `ataturk-bulvari-001`, zone `ataturk-bulvari` için "dim 75 ok":

```bash
mosquitto_pub -h <HOST> -p 8883 -u <USER> -P <PASS> --capath /etc/ssl/certs \
  -t 'city/lighting/device/ataturk-bulvari-001/status' \
  -m '{"deviceId":"ataturk-bulvari-001","zoneId":"ataturk-bulvari","action":"dim","value":75,"status":"ok","rssi":-67,"timestamp":"2026-06-23T10:00:01Z"}'
```

Beklenen:
- Dashboard ilgili zone'da parlaklığı **anında** %75'e çeker (SSE).
- `device_status` tablosuna yeni satır düşer; `devices.last_seen` güncellenir.
- O zone/cihaz için `pending` komut varsa `delivered` olur.

## 3) Hata durumu

`"status":"error"` gönder → dashboard'da zone rozeti `fault` olur.

## Topic hiyerarşisi (özet)

| Topic | Yön |
|---|---|
| `city/lighting/zone/{slug}/command` | Backend → ESP32 |
| `city/lighting/device/{deviceId}/command` | Backend → ESP32 |
| `city/lighting/device/{deviceId}/status` | ESP32 → Backend |
