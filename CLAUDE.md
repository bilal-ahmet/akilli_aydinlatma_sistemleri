# Akıllı Şehir Aydınlatma Sistemi — CLAUDE.md

## Proje Genel Bakış

Şehir genelindeki sokak lambalarını merkezi olarak yönetmek için geliştirilmiş IoT tabanlı aydınlatma kontrol sistemi. Dashboard üzerinden zone bazlı aç/kapa, dim kontrolü ve cihaz durumu izleme yapılabilir.

---

## Mimari

```
Dashboard (Next.js, SSE ile canlı)
    │   ▲
    │   │ SSE (status push: /api/events)
    │  REST API (komut gönder, durum oku)
    ▼
Backend (Next.js API Routes — Railway'de kalıcı Node process)
    │                        ▲
    │  MQTT publish (TLS)     │  MQTT subscribe (status, TLS)
    ▼                        │
MQTT Broker (HiveMQ Cloud, 8883/TLS)
    │                        ▲
    │  subscribe (command)    │  publish (status)
    ▼                        │
ESP32 (PubSubClient + WiFiClientSecure)
```

**Şu an:** ESP32 WiFi → HiveMQ Cloud (TLS/8883) → Backend (Railway) → Neon Postgres. Dashboard, MQTT status'larını SSE ile canlı alır.
**İleride:** LoRaWAN mimarisine geçilecek → `ESP32+LoRa → Gateway → Chirpstack → MQTT → Backend`

---

## Tech Stack

| Katman | Teknoloji |
|---|---|
| Frontend | Next.js 16, TypeScript, Tailwind CSS v4 |
| Backend | Next.js API Routes (runtime = nodejs) |
| Veritabanı | PostgreSQL (Neon) + **Drizzle ORM** |
| MQTT Broker | **HiveMQ Cloud** (TLS, port 8883) |
| Real-time | **SSE** (`/api/events`) — in-memory event bus |
| ESP32 Kütüphanesi | PubSubClient + ArduinoJson + WiFiClientSecure |
| Deploy | **Railway** (kalıcı Node sunucu, tek instance) |

> **Gerçekleşen mimari notu:** İlk taslaktan 3 bilinçli sapma var: (1) real-time için WebSocket yerine **SSE**, (2) self-host Mosquitto yerine **HiveMQ Cloud TLS**, (3) `zones` tablosuna `slug` + dashboard snapshot alanları eklendi. Kontrat (topic/payload/action semantiği) korundu. Detay aşağıda.

---

## Çok Müşterili Yapı (Multi-tenant) ve Giriş

Her **müşteri** (`customers`) kendi kullanıcı adı/şifresiyle girer ve yalnızca
kendi bölge/cihaz/lamba/telemetri/arıza verisini görür. **Bölge bir müşteriye
aittir** (`zones.customer_id`); cihazın müşterisi bölgesinden türetilir.

| Rol | Kapsam |
|---|---|
| `admin` | Platform yöneticisi (`customer_id` NULL). `/admin`'de tüm müşteriler; bir müşteriye tıklayınca `/c/<slug>` panelini **tüm fonksiyonlarıyla** kullanır. |
| `manager` | Müşteri yöneticisi: kendi panelinde tam yetki (bölge/cihaz/lamba/kullanıcı + komut). |
| `viewer` | Müşteri izleyicisi: salt okunur. |

Arayüzdeki adlar (`ROLE_LABELS`): admin **"Sistem yöneticisi"**, manager
**"Yönetici"**, viewer **"İzleyici"**.

**Dil: admin teknik, müşteri sade.** Admin her şeyi teknik terimlerle görür
(kanal/ch3, DALI, MAC, D4i, sürücü, ham firmware hata metni, Teknik detay).
Müşteri kullanıcıları (manager/viewer) sade dil görür: "Lamba 3 / Lamba
numarası", "Cihaz kodu", "Ölçümler", "Güç ünitesi"; Teknik detay ve arc seviyeleri gizli.
İstemcide `useTechnical()` (`_lib/panel.tsx`, `PanelInfo.technical = role === "admin"`),
kataloglarda `describeDeviceError(raw, { technical })` ve `faultLabel(code, technical)`
(teknik metin varsayılan; sunucu ve mobil kontratı değişmez), API hata
metinlerinde `msg(user, teknik, sade)` (`lib/api/respond.ts`). Yeni metin eklerken
müşteriye görünecekse bu ayrımı koru.

Müşteri metni ölçütü: belediye çalışanı açıklama istemeden anlamalı. İç kurallar
(0-63 aralığı, bağlantı numarası, toplu komut/topic), yer tutucular (`<numara>`)
ve efekt sıra numaraları müşteriye gösterilmez. Ölçümler sekmesinde müşteri
önce sade özeti (seviye, güç, enerji, sıcaklık, çalışma süresi, Durum) görür;
güç ünitesi/LED ayrıntıları ve arıza sayaçları kapalı "Ayrıntılar"dadır.

**Sayfalar:** `/login` · `/` (role göre yönlendirir) · `/admin` (müşteri kartları,
global acil komut) · `/admin/customers/<slug>` (bilgiler, pasifleştirme,
kullanıcılar, denetim kaydı) · `/hesap` (şifre değiştirme; ilk girişte zorunlu).

Müşteri paneli (tasarım: Claude Design "Fener Dashboard v2", kenar çubuklu):
`/c/<slug>` (Genel Bakış) · `/c/<slug>/bolgeler[/<zone>]` (bölge listesi +
detay) · `/c/<slug>/cihazlar` · `/c/<slug>/arizalar` · `/c/<slug>/efektler` ·
`/c/<slug>/kullanicilar` (manager/admin).

**Auth altyapısı (kütüphanesiz, Next.js 16 deseni):**

- `src/lib/auth/token.ts` — `jose` HS256 JWT, HttpOnly çerez `fener_session`
  (`{sub, role, cid, tv}`, 7 gün, kayan yenileme). `SESSION_SECRET` MQTT
  env'inden ayrı doğrulanır.
- `src/lib/auth/password.ts` — `node:crypto` scrypt; kullanıcı yokken de sahte
  doğrulama (zamanlama ile kullanıcı adı tahmini engellenir).
- `src/proxy.ts` — YALNIZCA iyimser kontrol (imza), `/login`'e yönlendirir / 401.
  **Güvenlik sınırı değildir.**
- `src/lib/auth/dal.ts` — sayfalar: `requireUser`, `requireAdmin`,
  `requireCustomerAccess(slug)` (başka müşteri → 404).
- `src/lib/auth/guard.ts` — API route'ları: `authorizeScope` (koleksiyon,
  `?customer=<slug>`), `authorizeZone`, `authorizeDevice`, `authorizeAdmin`,
  `authorizeCustomerManage`. Başka müşterinin kaynağına **404** (varlık sızmaz).
- `src/lib/tenancy.ts` — **bellek içi kiracı index'i** (bölge/MAC → müşteri,
  kullanıcı aktifliği + token sürümü). Komut yolu bu sayede DB'ye gitmez
  (Kural #10). Açılışta ısıtılır; **her CRUD sonrası `refreshTenancy()`**.
- `src/lib/audit.ts` — `audit_log`'a kim/hangi müşteri adına/ne yaptı.
- Hatalı giriş: IP+kullanıcı başına 15 dk'da 5 deneme, sonra kilit (bellek içi).
- Şifre değişimi/sıfırlama `token_version`'ı artırır → eski oturumlar düşer.
  Pasif kullanıcı/müşteri bir sonraki istekte düşer (SSE akışı heartbeat'te).

**Mobil oturum (Bearer, Flutter uygulaması `akilli_aydinlatma_mobil`):**

- İki token türü `typ` claim'iyle ayrılır ve birbirinin yerine GEÇMEZ:
  `web` (çerez, 7 gün) ve `access` (Bearer, **15 dk**, `sid` = `auth_sessions.id`).
  `typ`'siz eski çerezler `web` sayılır.
- `readSession()` (`lib/auth/session.ts`) TEK çözümleyicidir: önce
  `Authorization: Bearer`, yoksa çerez. Başlık var ama geçersizse çereze
  düşmez. Guard'lar, DAL ve SSE bunu kullandığı için hepsi iki yolu da kabul eder.
- Refresh token opak, 30 gün, **her kullanımda döner** (`auth_sessions`, yalnızca
  sha256 özeti). Rotasyondan sonra eski token 2 dk tolerans penceresinde
  kabul edilir (mobilde kaybolan yanıt), sonrasında gelirse çalınmış sayılır ve
  oturum iptal edilir (`auth.refresh_reuse`). Kod: `lib/auth/mobileSession.ts`.
- İptal: şifre değişimi/sıfırlama `token_version` ile hem access'i hem refresh'i
  düşürür. Çıkış o cihazın satırını iptal eder ve `lib/auth/revocation.ts`
  (bellek içi) elde kalan access token'ı anında düşürür.
- Web ve mobil giriş aynı doğrulamayı kullanır: `lib/auth/credentials.ts → authenticate`.

**İstemci:** `/c/[customer]/layout.tsx` `PanelProvider` kurar
(`src/app/_lib/panel.tsx`). Panel içindeki her `fetch` `useApi()` ile
`?customer=<slug>` ekler; `useLiveStatus` akışı müşteriye kapsamlar.
`canWrite=false` iken kontroller pasif gösterilir (asıl yetki sunucuda).

Layout ayrıca bölgeleri DB'den okuyup **`LightingProvider`**'a verir
(`src/app/_lib/lighting.tsx`): bölgeler, cihazlar, ölçüm özeti, süren arızalar
ve tüm komutlar (optimistic + seq/pending koruması, "Tüm Sistem" master'ı)
burada, tek yerde yaşar — sayfalar arası gezinmede state ve SSE aboneliği
kaybolmaz. Diyaloglar (bölge/cihaz formu, silme onayı, cihaz paneli, efekt
seçici) `DialogsProvider`'dadır (`_components/PanelDialogs.tsx`); sayfalar
`useDialogs()` ile açar. Sayfa görünümleri `_components/views/*View.tsx`.
Açık sorun sayısı (kenar çubuğu rozeti = Genel Bakış = Arızalar) tek
fonksiyondan: `_lib/alerts.ts → openAlerts` (lamba arızaları + komut hataları).

**İlk admin:** `npm run auth:create-admin -- <kullanici>` (şifre
`ADMIN_PASSWORD` env'inden ya da terminalden; `--reset` ile sıfırlama).
Kodda varsayılan şifre yoktur.

**İzolasyon testi:** `npm run check:tenancy` (çalışan sunucuya karşı; bkz.
`scripts/tenant-check.ts`). Komut testleri gerçek publish yapar — canlı
broker'a bağlı sunucuda çalıştırmayın.

---

## MQTT Yapılandırması

### Broker

```
Sağlayıcı: HiveMQ Cloud
Host: {cluster-id}.s1.eu.hivemq.cloud
Port: 8883 (yalnızca TLS — plain 1883 desteklenmez)
Auth: username + password
```

Backend `mqtts://` ile bağlanır (`src/lib/mqtt.ts`). ESP32 `WiFiClientSecure` kullanır.

### Topic Hiyerarşisi (MAC tabanlı — ESP ekibi kontratı)

Cihaz kimliği = **MAC adresi, iki noktasız** (örn. `A842E3123456`). Topic'ler bu
MAC'e göre üretilir (`src/lib/topics.ts`).

```
Meven:<MAC>/cmd    ← Backend publish, ESP32 subscribe (cihaz bazlı komut)
Meven:<slug>/cmd   ← Backend publish, o bölgedeki ESP32'ler subscribe (bölge komutu)
Meven:all/cmd      ← Backend publish, TÜM ESP32'ler subscribe (toplu komut)
Meven:<MAC>/data   ← ESP32 publish, Backend subscribe (durum/telemetri)
```

- **Bölge komutu = tek publish** (Kural #3): backend `Meven:<slug>/cmd`'ye bir kez
  yayınlar, cihaz listesini DB'den çözmez. ESP kendi bölge slug'ını firmware'deki
  `ZONE_SLUG`'tan bilir ve o topic'e subscribe olur.
- **Müşterinin "Tüm Sistem"i = müşterinin HER bölge topic'ine ayrı publish**
  (`publishCommand("customer", …)`, bölge listesi tenancy index'inden; Kural
  #3'ün bilinçli istisnası). `Meven:all/cmd`'ye tüm müşterilerin cihazları
  abone olduğu için müşteri "Tüm Sistem"i oraya GİTMEZ.
- **`Meven:all/cmd` yalnızca admin'in global acil komutudur**
  (`POST /api/admin/command/global`) — bütün müşterilerin bütün lambaları.
- **Bölge slug'ı = topic, global benzersiz.** `all`, 12 haneli hex (MAC
  biçimi) ve `c-` öneki rezervdir (`isReservedZoneSlug`). Silinen bölgenin slug'ı
  `retired_zone_slugs`'a yazılır ve **bir daha verilmez**: o slug ile flaşlanmış
  cihazlar topic'i dinlemeye devam eder, slug başka müşteriye verilseydi onun
  komutlarını alırdı.
- Backend veri aboneliği `+/data` (MQTT `+` joker'i `Meven:` ile aynı seviyeye
  gömülemez); MAC payload'daki `deviceId`'den okunur.
- **Not:** Bölge komutu SADECE `Meven:<slug>/cmd`'ye gider; backend MAC
  topic'lerine ayrıca fanout yapmaz. Bu yüzden tüm cihazlar `ZONE_SLUG` ile
  flash'lanmış olmalı — flash'lanmamış cihaz bölge komutu almaz. (Geçiş
  döneminde geçici MAC fanout'u vardı; tüm cihazlar flash'landığı için
  kaldırıldı — flash'lı cihazlar komutu iki kez alıyordu.)

### QoS Seviyeleri

- Komutlar (cmd): **QoS 1** — en az bir kez iletim garantisi
- Veri (data): **QoS 0** — fire and forget, yüksek frekanslı

---

## Payload Formatları

### Command Payload (Backend → ESP32, `Meven:<MAC>/cmd` veya `Meven:all/cmd`)

```json
{ "action": "dim", "value": 75, "channel": 3 }
```

`action` değerleri: `"on"` | `"off"` | `"dim"` | `"efekt"`
`value`: 0–100 arası integer (yalnızca dim için kullanılır)
`channel`: hedef **DALI kanalı (lamba)** — 0–63. Bir ESP'ye birden çok bağımsız
aydınlatma bağlanabilir; her biri bu kanal no ile ayrı sürülür.

> **⚠ TÜM LAMBALAR = `channel` alanını HİÇ GÖNDERME.** Toplu komutlarda (cihazın
> "Tüm cihaz"ı, bölge, "Tüm Sistem") payload'da `channel` **bulunmaz**; cihaz
> alanın yokluğundan tüm lambaları anlar. Bir dönem bunun için DALI broadcast
> adresi (255) gönderiliyordu — **firmware bunu artık reddediyor**
> (`"bilinmeyen action"`), o yüzden 255 tamamen kaldırıldı (`buildPayload`).
> API kontratı zaten aynıydı: `channel` yokluğu = tüm cihaz. Sahada doğrulamak
> için: `npm run watch:cmd`.

**Efekt komutu:** `{ "action": "efekt", "number": 10 }` — `number`
1-tabanlı efekt sıra no, donmuş katalog `src/lib/effects.ts`. `channel` ile tek
lambaya da verilebilir. on/off/dim efekti durdurur. Bölge snapshot'ında
`zones.active_fx`, lamba snapshot'ında `fixtures.active_fx` olarak optimistic
tutulur.

Katalog **iki aileye** ayrılır (tam tablo: `firmware/ESP32-ENTEGRASYON.md` §4):

- **Tek lamba (1-13, 15-22)** — `channel` ile tek DALI adresine verilebilir.
- **Çok lambalı (14, 23-28)** — hattın tamamını birlikte sürer, **`channel`
  KABUL ETMEZ** ve `minLamps` kadar lamba ister.

> Doğrulama sınırı `EFFECT_MAX_NUMBER` (katalogun en büyük numarası),
> **`EFFECT_COUNT` değil**. Şu an ikisi de 28, ama bir numara atlanırsa yalnızca
> ilki doğru kalır — katalog dizisi de numara sırasında değil, aileye göre gruplu.

**Çok lambalı efektler (`allLamps` + `minLamps`)**: `buildPayload` bu efektlerde
tek lamba seçilse bile `channel` alanını hiç koymaz,
`DeviceControlModal` tek lamba seçili olsa da komutu cihazın tamamına gönderir,
`EffectPicker` lambası yetmeyen efektleri pasif gösterir (`lampCount` yalnızca
tek cihaz hedefinde bilinir; bölge/"tüm sistem"de efekt sunulur, yetersiz cihaz
kendi hatasını döner). Cihaz ayrıca aynı anda en fazla 4 kanalda efekt çalıştırır
— dolduğunda `efekt baslatilamadi (bos slot yok…)` döner.

**Çok lambalı efekt cihaz geneli durur.** Böyle bir efekt çalışırken bir lambada
yapılan her işlem (efekti durdur, aç/kapa, şiddet, tek lamba efekti) efekti önce
cihazın TAMAMINDA durdurur: `DeviceControlModal` kanalsız `dim` (son "Tüm cihaz"
şiddeti) gönderir, lamba komutu bu isteğin yanıtını bekleyip ardından gider
(iki POST paralel gitseydi sıra bozulabilirdi). Sunucu da aynı kuralı snapshot'a
uygular (`recordCommand`): kanal taşıyan allLamps efekti tüm lambalara yazılır,
allLamps efektindeki lambaya gelen kanal komutu diğer lambaların `active_fx`'ini
temizler (`clearGroupEffect`) — mobil/API istemcileri de tutarlı kalır.

**Efektler sayfası** bölge altında cihaz seçimi sunar: bölgenin tamamı seçiliyse
bölge komutu (tek publish), yalnızca bazı cihazları seçiliyse her birine cihaz
komutu (`EffectTarget = "all" | { zones, devices }`). Cihazın lamba sayısı ve
çalışan efekti `GET /api/devices` → `lampCount`, `activeFx` (fixtures'tan).

**Mors efekti (no 22):** ek `text` alanı alır —
`{ "action": "efekt", "number": 22, "text": "MERHABA" }` (tek lambaya verilecekse
ek olarak `"channel": 3`).
Harf, rakam ve boşluk; en fazla 32 karakter (`MORSE_TEXT_MAX`). `text`
gönderilmezse cihaz **son ayarlanan metni** tekrar çalar; bu yüzden boş string
gönderilmez, alan payload'a hiç konmaz. Girdi `normalizeMorseText` ile indirgenir
(Türkçe harfler ASCII'ye: Ş→S, desteklenmeyen karakterler atılır) — hem
dashboard'da anlık, hem `commandRequestSchema`'da sunucu tarafında.

### Data Payload (ESP32 → Backend, `Meven:<MAC>/data`)

Bu topic'te **üç kontrat** akar; ayrım `src/types/lighting.ts` → `parseUplink`
içinde yapılır. Yeni iki formatta payload'da `deviceId` **yoktur** — MAC
topic'ten çözülür (`macFromDataTopic`).

**1. Komut yanıtı** — cihaz her komuttan sonra sonucu yayınlar:

```json
{ "status": "ok" }
{ "status": "error", "error": "bilinmeyen action" }
```

Hata metni SSE ile dashboard'a gider: sağ altta bildirim + cihaz kartında rozet
(`devices.last_error`, sonraki `ok` yanıtında temizlenir). En son bekleyen komut
`commands.status='failed'` olur ve o komutun `channel`'ı olaya eklenir (yanıt
kanal taşımıyor; kanala özgü hatalarda hangi lamba olduğunu göstermek için).

Ham metinler `src/lib/deviceErrors.ts` kataloğunda okunur başlık + sebep +
ipucuna çevrilir (`describeDeviceError`); UI ham metin yerine bunu gösterir.
Sayı taşıyan metinler (`bu efekt en az N lamba ister…`, efekt aralığı) regex ile
eşleşir, böylece firmware sınırları değişince katalog bozulmaz. **Tanınmayan
metin yutulmaz**, `known:false` ile ham haliyle gösterilir. Tam tablo:
`firmware/ESP32-ENTEGRASYON.md` §5.1.

**2. D4i periyodik rapor** — DALI adresi (lamba) başına bir mesaj:

```json
{
  "type": "d4i_periodic", "address": 1, "online": true,
  "status": { "status": 4, "lamp_power_on": 255, "actual_level": 254,
              "max_level": 254, "min_level": 157, "lamp_failure": null },
  "d4i_supported": true,
  "d4i": { "energy": {...}, "power": {...}, "load_power": { "value": 39, "unit": "W" },
           "driver": {...}, "led": {...} }
}
```

- `address` → `fixtures.channel`. Her mesaj **tek** adres taşır; bölge/cihaz
  agregatı bu yüzden tek mesajdan değil, cihazın tüm `fixtures` satırlarından
  türetilir.
- `actual_level` 0–254 DALI arc level → yüzdeye **doğrusal** çevrilir
  (`levelToPercent`, tek dönüşüm noktası).
- DALI sorgu yanıtları üç durumlu: `255` evet, `0` hayır, `null` yanıt yok
  (`flagToBool`).
- `power` = şebekeden **çekilen** güç, `load_power` = LED'e giden **yük** gücü.
  İkisi farklıdır (47,4 W ↔ 39 W), panelde ayrı gösterilir.
- Raporun tamamı `d4i_telemetry`'ye yazılır (ham `d4i` bloğu `raw` JSONB'de);
  cihaz modalindeki "D4i telemetrisi" paneli `GET /api/devices/:id/telemetry`
  ile bunu okur.

#### Doğrulanmış / tahmini / ham ölçümler

Sürücü LED ölçümlerini kendisi **doğruluyor** ve güvenmediğini `null`'a çekiyor:

```jsonc
"voltage_v": null,                  // doğrulanmış değer — YOK
"voltage_reported_v": 1.8,          // ham ölçüm (yanıltıcı)
"voltage_estimated_v": 65.878,      // sürücünün tahmini
"voltage_plausible": false,
"voltage_implausibility_reason": "load_power_current_mismatch"
```

Okuma sırası tek yerde: `src/lib/d4i.ts` → `readMeasurement(block, ad, birim)`
→ **doğrulanmış → tahmini → ham**. UI'da doğrulanmış düz, tahmini `≈`,
doğrulanmamış ham `*` ile yazılır; ham değerler ve sebep kodları ana ızgarada
değil, lamba kartının "Teknik detay" bölümünde durur (`bank_206_raw_hex`,
ölçek üsleri, `*_available/plausible` alanları da oraya aittir).

> **`d4i_telemetry.led_voltage_v / led_current_a / led_temperature_c` sütunları
> yalnızca DOĞRULANMIŞ değeri taşır**, yani yeni firmware'de çoğunlukla NULL'dur.
> Panel bu yüzden ölçümleri sütunlardan değil `raw`'dan okur. Tahminler üzerinden
> grafik gerekirse ayrı `*_estimated_*` sütunları + migration eklenmeli.

Arıza sayaçları 1 baytlıktır ve tavana ulaşınca saymayı bırakır; firmware bunu
`<key>_count_saturated: true` + `<key>_count_text: "253+"` ile bildirir
(`readCounter`). Panel `253` yerine `253+` yazar — sayaçlar birbirinden
bağımsızdır, `general_failure_count` diğerlerinin toplamı **değildir**.

**3. Eski rapor (geriye uyum)** — `deviceId` alanı olan ilk kontrat:

```json
{
  "deviceId": "A842E3123456",
  "brightness": 75,
  "relayStatus": "on",
  "temperature": 42,
  "rssi": -67,
  "status": "ok"
}
```

Çok-lamba (DALI kanalları) — her lamba `channels[]` içinde kanal başına raporlanır:

```json
{
  "deviceId": "A842E3123456",
  "temperature": 42, "rssi": -67, "status": "ok",
  "channels": [
    { "ch": 0, "brightness": 45, "relayStatus": "on" },
    { "ch": 1, "brightness": 80, "relayStatus": "on" },
    { "ch": 2, "brightness": 0,  "relayStatus": "off" }
  ]
}
```

`relayStatus`: `"on"` | `"off"` · `status`: `"ok"` | `"error"`. `channels` gelince her
kanal `fixtures` tablosuna upsert edilir; bölge snapshot'ı kanallardan türetilen
cihaz-seviyesi agregatla (açık kanal varsa `isOn`, parlaklık açık kanal ortalaması)
rafine edilir. `channels` yoksa mevcut tek-lamba davranışı korunur.

> **LoRa Notu:** Payload yapısı kasıtlı olarak minimal tutulmuştur. LoRa'ya geçişte JSON yerine binary encoding kullanılacak ancak action/value/MAC semantiği değişmeyecek. Transport katmanı değişir, kontrat değişmez.

---

## API Endpoint'leri

> **Tüm `/api/*` route'ları oturum ister** (`/api/auth/login` hariç). Koleksiyon
> route'ları (`GET/POST /api/zones`, `GET/POST /api/devices`, `/api/summary`,
> `/api/faults`, `/api/events`, `/api/command/all`) müşteri kapsamını
> `?customer=<slug>` ile alır: müşteri kullanıcısında opsiyonel (her zaman
> kendisi, başka slug → 403), admin'de zorunlu (yoksa 400). Kaynak route'ları
> (`/api/zones/:slug/*`, `/api/devices/:mac/*`) sahipliği kaynaktan okur.
> Yazma işlemleri `viewer` için 403.

### Giriş ve Hesap

```
POST /api/auth/login      { username, password }  → çerez + { redirect }      (web)
POST /api/auth/logout     { refreshToken? }       → çerezi siler; Bearer/refresh ise o mobil oturumu iptal eder
POST /api/auth/password   { currentPassword, newPassword }  → web: yeni çerez · mobil: { tokens }
GET  /api/auth/me                                 → Me { id, username, displayName, role, canWrite,
                                                         mustChangePassword, customer: {id,slug,name,isActive}|null }
POST /api/auth/token      { username, password, deviceName?, platform? }   (mobil)
                          → { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user: Me }
POST /api/auth/refresh    { refreshToken }        → yeni çift + user (rotasyon)          (mobil)
```

`/api/auth/login`, `/logout`, `/token`, `/refresh` guard'sızdır ve proxy'de public'tir.
`/api/auth/me` şifre değiştirmesi gereken kullanıcıya da açıktır.

### Yönetim (admin)

```
GET/POST        /api/admin/customers              # liste (sayılar + ölçülmüş özet) / oluştur
GET/PATCH/DELETE /api/admin/customers/:slug       # bilgi, isActive; silme yalnızca bölgesizse
POST            /api/admin/command/global         # Meven:all/cmd — TÜM müşteriler
GET/POST        /api/customers/:slug/users        # admin veya o müşterinin manager'ı
PATCH/DELETE    /api/customers/:slug/users/:id    # rol, aktiflik, şifre sıfırlama
PATCH           /api/zones/:slug { customerSlug } # (admin) bölgeyi cihazlarıyla başka müşteriye taşı
```

### Komut Gönderme

```
POST /api/zones/:zoneId/command
POST /api/devices/:deviceId/command       # channel ile tek lamba, yoksa tüm cihaz
POST /api/command/all?customer=<slug>     # müşterinin "Tüm Sistem"i (bölge topic'lerine fanout)

Body:
{
  "action": "dim" | "on" | "off" | "efekt",
  "value": 0-100,          # dim için
  "number": 1-14 | 22,     # efekt için (katalog: src/lib/effects.ts)
  "text": "MERHABA",       # (opsiyonel) yalnızca Mors efektinde (no 22), ≤32 karakter
  "channel": 0-63          # (opsiyonel) tek DALI kanalı (lamba); cihaz komutunda
}
```

Backend bu endpoint'leri aldığında ilgili MQTT topic'ine publish eder.

**Cihaz yönetimi:**

```
POST   /api/devices              → cihaz ekle { mac, zoneSlug, name? }
PATCH  /api/devices/:deviceId    → bölge / isim güncelle { zoneSlug?, name? }
DELETE /api/devices/:deviceId    → cihazı ve tüm kayıtlarını sil
```

> **Bölge değişikliği yalnızca dashboard kaydını taşır.** Cihazın hangi
> `Meven:<slug>/cmd` topic'ini dinlediği firmware'deki `ZONE_SLUG`'tan gelir
> (Kural #3); cihaz yeniden flaşlanana kadar **eski** bölgenin toplu komutlarını
> almaya devam eder, yeninin komutlarını almaz. Tekil (MAC) ve `Meven:all/cmd`
> komutları etkilenmez. Dashboard bölge seçimi değiştiğinde bu uyarıyı gösterir.
> MAC değiştirilemez: cihazın kimliği odur, tüm telemetri/lamba kayıtları ona bağlı.
>
> **Cihaz başka MÜŞTERİNİN bölgesine taşınamaz** (admin için de): eski
> `ZONE_SLUG`'ı dinlemeye devam edeceği için eski müşterinin bölge komutlarını
> almayı sürdürürdü. Müşteri değişimi bölge seviyesinde yapılır (admin bölgeyi
> taşır; slug değişmez, yeniden flaş gerekmez). Başka müşteride kayıtlı MAC
> eklenmek istenirse 409 döner ve sahip açıklanmaz. Cihaz/bölge silinince
> `fault_events` dahil tüm MAC kayıtları silinir (MAC başka müşteriye geçerse
> eski geçmiş sızmasın).

**Lamba (DALI kanal) yönetimi:**

```
GET    /api/devices/:deviceId/fixtures          → cihaza bağlı lambalar
POST   /api/devices/:deviceId/fixtures          → manuel lamba ekle { channel, name? }
PATCH  /api/devices/:deviceId/fixtures/:channel → isim / kanal güncelle { channel?, name? }
DELETE /api/devices/:deviceId/fixtures/:channel → lamba kaydını sil
GET    /api/devices/:deviceId/telemetry         → kanal başına son D4i raporu
GET    /api/devices/:deviceId/faults?limit=100  → arıza geçmişi (süren + çözülen)
```

> **Lamba `channel`'ı = cihazın DALI adresi**, sadece bir etiket değil. PATCH ile
> değiştirmek yalnızca yanlış girilmiş adresi düzeltmek içindir: eski adresin
> D4i geçmişi eski `channel` altında kalır ve cihaz o adresi raporlamayı
> sürdürürse satır `upsertFixture` ile yeniden oluşur. İsim (`name`) cihaz
> raporlarında hiç ezilmez — upsert patch'i `name` taşımaz.

### Durum Okuma

```
GET /api/zones/:zoneId/status        → Son bilinen zone durumu (DB'den)
GET /api/devices/:deviceId/status    → Cihaz son durumu
GET /api/zones                       → Tüm zone listesi
GET /api/devices                     → Tüm cihaz listesi (+ lampCount, activeFx: fixtures'tan)
GET /api/summary                     → Dashboard üst şeridi: ölçülmüş sistem özeti
```

`/api/summary`, her lambanın **son** D4i raporundan (kanal başına `DISTINCT ON`,
son 10 dakika) toplar: çekilen güç, yük gücü, ortalama LED gerilimi (**gerilim
toplanmaz**) ve `fault_events`'ten açık arızası olan **farklı lamba** sayısı.
Ölçüm yoksa `powerW: null` döner ve dashboard direk sayısına dayalı tahmine
düşer. Değerler ham `raw` bloğundan `lib/d4i.ts` ile okunur — panelle aynı
doğrulanmış → tahmini → ham kuralı. Yanıt ayrıca `devices` (MAC → aynı
ölçümler) kırılımını taşır; cihaz tablosu ve bölge detayı (istemcide
cihazlarından toplanır) bunu kullanır. Son 10 dk'da rapor vermeyen cihaz
kırılımda yoktur → panelde "Veri bekleniyor".

```
GET /api/faults             → süren lamba arızaları (cihaz + bölge bilgisiyle)
GET /api/faults?days=30     → + son N günde (1-90) çözülenler (id, resolvedAt)
```

### Dashboard Real-time (SSE)

Dashboard cihaz durumlarını real-time takip etmek için **SSE** (Server-Sent Events) kullanır — Next.js App Router'da native çalışır, custom server gerekmez:

```
GET /api/events      → Backend'in MQTT'den aldığı status mesajlarını push eder (text/event-stream)
```

Frontend tarafı: `src/app/_lib/useLiveStatus.ts` (`EventSource`). Backend köprüsü: `src/lib/events.ts` (in-memory EventEmitter). **Bu yüzden backend tek instance çalışmalı** (bkz. Kurallar #8).

**Arıza alan olayları (domain events):** `lib/domainEvents.ts` ayrı bir bus'tır.
Arıza epizodu açılınca/kapanınca `fault.opened` / `fault.resolved` yayınlanır;
TEK yayın noktası `lib/faultLog.ts → syncFaultEvents` (DB yazımından sonra).
SSE bunları **isimli olay** olarak iletir:

```
event: fault
data: {"type":"fault.opened","id":123,"deviceId":"A842E3123456","channel":2,"code":"lamp_failure","detail":null,"startedAt":"…","resolvedAt":null}
```

Tarayıcıdaki `EventSource.onmessage` isimli olayları almaz (web etkilenmez);
mobil uygulama olay adına göre ayrıştırır. İleride push (FCM) göndericisi de
bu bus'a abone olur — arıza koduna dokunulmaz.

> **SSE tek başına yetmez.** Akış koptuğunda (proxy zaman aşımı, uyuyan sekme)
> EventSource yeniden bağlanır ama **kaçırdığı olayları tekrar oynatmaz**. Bu
> yüzden ana sayfadaki bölge kartları ve cihaz listesi `useReconcile` ile
> periyodik (30 sn) ve sekme öne gelince DB'den yeniden okunur. Mutabakat,
> uçuşta komut varken ya da son komuttan sonraki 5 sn içinde atlanır — yoksa
> `recordCommand` daha DB'ye yazmadan optimistic durum eski veriyle ezilir.

---

## Veritabanı Şeması

### `customers` / `users`

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) UNIQUE NOT NULL,     -- URL: /c/<slug>
  name VARCHAR(150) NOT NULL,
  contact_name, contact_email, contact_phone, notes,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- pasif: kullanıcılar giremez, cihazlar çalışır
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) UNIQUE NOT NULL,  -- küçük harf
  password_hash TEXT NOT NULL,           -- scrypt$N$r$p$salt$hash
  display_name VARCHAR(150),
  role VARCHAR(20) NOT NULL,             -- admin | manager | viewer
  customer_id UUID REFERENCES customers(id),  -- admin: NULL (CHECK ile zorunlu)
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  token_version INTEGER NOT NULL DEFAULT 0,   -- artınca eski oturumlar düşer
  last_login_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);
```

`auth_sessions(id, user_id FK users ON DELETE CASCADE, refresh_hash UNIQUE,
prev_refresh_hash, token_version, device_name, platform, created_at, last_used_at,
expires_at, revoked_at)` — mobil cihaz oturumları (migration `0007_auth_sessions.sql`).

Ayrıca: `retired_zone_slugs(slug PK, customer_id, retired_at)` — silinmiş bölge
slug'ları, bir daha verilmez. `audit_log(id, at, user_id, username, customer_id,
action, target, detail JSONB, ip)` — CRUD ve giriş denetimi. `commands`'a
`user_id` ve `customer_id` eklendi; `target_type` artık `zone | device | customer | all`.

> Migration `0006_multi_tenant.sql` elle düzenlendi: `meven-arge` ("Meven ArGe")
> müşterisini oluşturur, mevcut tüm bölgeleri ona bağlar, sonra
> `zones.customer_id`'yi NOT NULL yapar.

### `zones`

```sql
CREATE TABLE zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(100) UNIQUE NOT NULL,  -- MQTT topic / API public id (örn. "ataturk-bulvari")
  customer_id UUID NOT NULL REFERENCES customers(id),  -- sahip müşteri
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  -- dashboard snapshot alanları (Kural #6'yı zone seviyesinde sağlar):
  district    VARCHAR(100),
  pole_count  INTEGER NOT NULL DEFAULT 0,
  is_on       BOOLEAN NOT NULL DEFAULT FALSE,
  brightness  INTEGER NOT NULL DEFAULT 0,
  status      VARCHAR(20) NOT NULL DEFAULT 'ok',  -- ok | warning | fault
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

> Gerçek tanımlar Drizzle ile `src/lib/db/schema.ts`'te; migration `drizzle/`. API ve MQTT topic'lerinde zone için `slug` kullanılır (UUID değil).

### `devices`

```sql
CREATE TABLE devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     VARCHAR(100) UNIQUE NOT NULL,  -- ESP32 tanımlayıcısı (MAC)
  zone_id       UUID REFERENCES zones(id),
  name          VARCHAR(100),
  last_seen     TIMESTAMPTZ,
  last_error    VARCHAR(200),   -- son komut yanıtı hatası (ok gelince NULL'lanır)
  last_error_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### `fixtures`

Bir ESP'ye (cihaza) bağlı tek bağımsız aydınlatma = DALI kanalı. Bir cihazda
birden çok lamba olabilir; her biri `channel` (0-63) ile adreslenir ve bağımsız
kontrol edilir. Cihaz verisinden (`channels[]`) otomatik upsert edilir; dashboard'dan
manuel de eklenebilir.

```sql
CREATE TABLE fixtures (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   VARCHAR(100) NOT NULL,          -- MAC (devices.device_id'ye mantıksal ref)
  channel     INTEGER NOT NULL,               -- DALI kanal (lamba) no, 0-63
  name        VARCHAR(100),
  brightness  INTEGER NOT NULL DEFAULT 0,
  is_on       BOOLEAN NOT NULL DEFAULT FALSE,
  active_fx   INTEGER,                         -- aktif efekt (1-14, null = yok)
  status      VARCHAR(20) NOT NULL DEFAULT 'ok',
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, channel)
);
CREATE INDEX idx_fixtures_device_id ON fixtures(device_id);
```

### `device_status`

```sql
CREATE TABLE device_status (
  id          BIGSERIAL PRIMARY KEY,
  device_id   VARCHAR(100) NOT NULL,
  action      VARCHAR(20),
  value       INTEGER,
  status      VARCHAR(20),
  rssi        INTEGER,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_device_status_device_id ON device_status(device_id);
CREATE INDEX idx_device_status_recorded_at ON device_status(recorded_at DESC);
```

### `d4i_telemetry`

`d4i_periodic` raporlarının append-only geçmişi — DALI adresi başına bir satır.
Sık okunan büyüklükler ayrı sütunda, raporun ham `d4i` bloğu (sürücü/LED arıza
sayaçları dahil) `raw` JSONB'de.

```sql
CREATE TABLE d4i_telemetry (
  id            BIGSERIAL PRIMARY KEY,
  device_id     VARCHAR(100) NOT NULL,   -- MAC (topic'ten)
  channel       INTEGER NOT NULL,        -- payload'daki `address`
  online        BOOLEAN,
  d4i_supported BOOLEAN NOT NULL DEFAULT FALSE,
  status_byte   INTEGER,  actual_level INTEGER,      -- 0-254 arc level
  min_level     INTEGER,  max_level    INTEGER,  physical_min_level INTEGER,
  lamp_failure  BOOLEAN,  lamp_power_on BOOLEAN, control_gear_present BOOLEAN,
  energy_wh     DOUBLE PRECISION, power_w DOUBLE PRECISION,
  driver_temperature_c INTEGER, driver_voltage_v INTEGER, driver_operating_time_s INTEGER,
  led_temperature_c INTEGER, led_voltage_v DOUBLE PRECISION, led_current_a DOUBLE PRECISION,
  raw           JSONB,                   -- `d4i` bloğunun tamamı
  recorded_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_d4i_telemetry_device_channel ON d4i_telemetry(device_id, channel);
CREATE INDEX idx_d4i_telemetry_recorded_at ON d4i_telemetry(recorded_at DESC);
```

> Cihaz kanal başına ~30 sn'de bir yayın yapar; tablo sınırsız büyür. İleride
> saklama politikası (örn. 90 günden eskiyi sil) gerekecek.

### `fault_events`

Arıza **geçmişi** — epizot başına tek satır (başlangıç + çözülme anı).
`resolved_at IS NULL` → arıza sürüyor.

```sql
CREATE TABLE fault_events (
  id         BIGSERIAL PRIMARY KEY,
  device_id  VARCHAR(100) NOT NULL,   -- MAC
  channel    INTEGER,                 -- DALI adresi; NULL = cihaz seviyesi (komut hatası)
  code       VARCHAR(60) NOT NULL,    -- lamp_failure | gear_failure | offline
                                      -- | driver.<key> | led.<key> | command.<errorCode>
  detail     VARCHAR(300),            -- ham hata metni (komut hatası)
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_fault_events_device_started ON fault_events(device_id, started_at DESC);
CREATE INDEX idx_fault_events_open ON fault_events(device_id, channel, resolved_at);
```

> **Neden ayrı tablo?** Arıza geçmişi `d4i_telemetry`'den türetilemez: cihaz
> kanal başına ~30 sn'de bir rapor yazdığı için 7 günlük geçmiş bile yüz
> binlerce satır taramak demek. Bu tabloya yalnızca **durum değişiminde**
> yazılır (`src/lib/faultLog.ts` → `syncFaultEvents`): yeni görülen kod için
> satır açılır, artık görülmeyen açık satır kapatılır. Aynı arıza tekrar
> raporlandığında hiçbir yazma olmaz.
>
> Arıza kodu kataloğu (bayrak adları + okunur başlıklar) `src/lib/faults.ts` —
> hem D4i panelindeki rozetler hem geçmiş listesi aynı listeden okur.
> Komut hataları cihaz seviyesine (`channel = NULL`) yazılır; yanıt hangi
> lambaya ait olduğunu taşımaz. Sonraki `{"status":"ok"}` yanıtı açık komut
> hatasını kapatır (`devices.last_error` ile aynı semantik).

### `commands`

```sql
CREATE TABLE commands (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID UNIQUE NOT NULL,
  target_type VARCHAR(20) NOT NULL,  -- 'zone' | 'device'
  target_id   VARCHAR(100) NOT NULL,
  channel     INTEGER,               -- hedef DALI kanal (lamba) no; NULL = tüm cihaz
  action      VARCHAR(20) NOT NULL,
  value       INTEGER,
  status      VARCHAR(20) DEFAULT 'pending',  -- 'pending' | 'delivered' | 'failed'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
```

---

## MQTT — Backend Entegrasyon Örneği

```typescript
// src/lib/mqtt.ts (özet — gerçek dosyada globalThis singleton + Drizzle yazımı var)
import mqtt from 'mqtt';

const client = mqtt.connect({
  protocol: 'mqtts',            // HiveMQ Cloud TLS
  host: process.env.MQTT_HOST,
  port: Number(process.env.MQTT_PORT), // 8883
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
});

client.on('connect', () => {
  // Tüm cihaz status'larını dinle
  client.subscribe('city/lighting/device/+/status', { qos: 0 });
});

client.on('message', (topic, payload) => {
  const data = JSON.parse(payload.toString());
  // DB'ye kaydet, WebSocket üzerinden dashboard'a ilet
});

export async function publishCommand(
  targetType: 'zone' | 'device',
  targetId: string,
  action: 'on' | 'off' | 'dim',
  value?: number
) {
  const topic = `city/lighting/${targetType}/${targetId}/command`;
  const payload = JSON.stringify({
    action,
    value,
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
  client.publish(topic, payload, { qos: 1 });
}
```

---

## Ortam Değişkenleri (.env)

```env
# Veritabanı (Neon — pooled, sslmode=require)
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require

# MQTT (HiveMQ Cloud — TLS)
MQTT_HOST={cluster-id}.s1.eu.hivemq.cloud
MQTT_PORT=8883
MQTT_USER=backend-service
MQTT_PASS=****

# Oturum çerezi imza anahtarı (≥32 karakter; openssl rand -base64 48).
# Değişirse tüm oturumlar düşer.
SESSION_SECRET=****

# Uygulama (SSE; aynı origin olduğu için varsayılan /api/events)
NEXT_PUBLIC_SSE_URL=/api/events
```

> Lokal geliştirme şablonu için `.env.example`. Gerçek değerler `.env.local`'a (gitignored) yazılır; canlıda Railway **Service Variables**'ta tutulur.

---

## Önemli Kurallar ve Kararlar

1. **HTTP sadece dashboard ↔ backend arasında** kullanılır. ESP32 HTTP kullanmaz.
2. **ESP32 hiçbir zaman polling yapmaz.** Komutları MQTT subscribe ile alır.
3. **Zone komutu = tek MQTT publish** → o zone'daki tüm cihazlar alır. Her cihaza ayrı istek gönderilmez.
4. **Payload minimal tutulur.** LoRa geçişinde binary encode edilecek, semantik değişmeyecek.
5. **Command tablosunda requestId ile idempotency** sağlanır; aynı komut iki kez uygulanmaz.
6. **Cihaz durumu DB'de son snapshot olarak tutulur.** Dashboard her zaman DB'den okur, MQTT'den değil. Zone snapshot'ı `zones` tablosunda; komut publish'inde optimistic güncellenir, cihaz status'u gelince rafine edilir.
   **Bölge/toplu komut `fixtures`'ı da günceller** (`patchFixtures`): yalnızca
   `zones` güncellenirse lamba kayıtları kapalı kalır, cihaz modali lambaları
   yanlış gösterir ve kullanıcı gereksiz yere tekrar "aç" komutu gönderir.
   Cihaz-seviyesi görünümler (modaldeki "Tüm cihaz") `device_status` yerine
   **`fixtures`'tan türetilir** — `device_status` yalnızca cihaz telemetri
   yayınladığında yazılır, komuttan sonra bayattır.
7. **LoRa geçişinde** transport katmanı değişir (Chirpstack → MQTT → Backend), API kontratı aynı kalır.
8. **Backend TEK instance çalışır.** MQTT subscribe + SSE köprüsü in-memory event bus'a (`src/lib/events.ts`) dayanır; çoklu instance'ta status olayları farklı process'lere düşer ve canlı güncelleme bozulur. Yatay ölçekleme gerekince çözüm: Redis pub/sub (örn. Upstash).
9. **MQTT/env hatası web sunucusunu düşürmez.** `src/instrumentation.ts` MQTT başlatmayı try/catch ile sarar; broker erişilemese bile dashboard (DB okuması) çalışır.
10. **Publish önce, DB sonra.** Komut yolunda `publishCommand` (senkron, DB'ye dokunmaz) isteği alır almaz MQTT'ye yazar; `commands` INSERT'i, zone snapshot'ı ve SSE `recordCommand`'a taşınıp route'larda `after()` ile arka plana alınır. Sebep: publish DB'nin arkasındayken Neon round-trip'i (+ scale-to-zero uyanması) komutu saniyelerce geciktiriyordu. **Komut yoluna asla `await db...` eklemeyin** — snapshot/log işleri `recordCommand`'a girer. Ödün: zone/device bulunamasa da 202 döner (var olmayan topic'e publish zararsız, `recordCommand` warn'lar). Yetki kontrolü de DB'ye gitmez: tenancy index'i + JWT (`lib/auth/guard.ts`).
11. **Her `/api/*` route'u guard ile başlar** (`authorize*`, `lib/auth/guard.ts`); yalnızca `/api/auth/login`, `/api/auth/logout`, `/api/auth/token` ve `/api/auth/refresh` hariç. `src/proxy.ts` iyimser kontroldür, tek başına güvenlik sınırı değildir. Yeni route eklerken guard'ı unutma.
12. **Her sorgu müşteriye göre süzülür.** Liste sorguları `zones.customer_id` (ya da `tenancy` → `customer.macs`) ile kapsamlanır; kayıtsız MAC'lerin telemetrisi hiçbir müşteriye görünmez. Canlı olaylar `customerId` ile etiketlenir, SSE route'u buna göre süzer.
13. **`Meven:all/cmd` yalnızca admin'in global komutudur.** Müşteri "Tüm Sistem"i bölge topic'lerine fanout'tur.
14. **Bölge slug'ı rezerv listesine takılmaz ve asla yeniden kullanılmaz** (`isReservedZoneSlug`, `retired_zone_slugs`, `lib/zoneSlug.ts → allocateZoneSlug`).
15. **Sahiplik değiştiren her CRUD `refreshTenancy()`'yi yanıt dönmeden bekler** (bölge/cihaz/müşteri/kullanıcı). Aksi halde sonraki istek eski sahipliği görür.
16. **Mobil uygulamada kontrat kopyaları var.** Flutter uygulaması şu dosyaların Dart karşılıklarını taşır: `lib/effects.ts`, `lib/deviceErrors.ts`, `lib/faults.ts`, `lib/d4i.ts`, `app/_lib/deviceHealth.ts`, `app/_lib/alerts.ts`, `lib/auth/roles.ts`. Bunlardan biri değişirse mobildeki `lib/contracts/` karşılığı da güncellenmeli. API yanıt şekli değişikliği de mobili kırar. Mobil müşteriye yönelik olduğu için katalogların **sade** metinlerini (`plain`, `plainLabel`) kullanmalı.

---

## Klasör Yapısı (Önerilen)

```
/
├── src/
│   ├── instrumentation.ts                # açılışta MQTT + tenancy index (try/catch)
│   ├── proxy.ts                          # iyimser oturum kontrolü (/login yönlendirme)
│   ├── app/
│   │   ├── page.tsx                      # role göre yönlendirici
│   │   ├── login/ · hesap/               # giriş, şifre değiştirme
│   │   ├── admin/                        # müşteri listesi, müşteri ayarları
│   │   ├── c/[customer]/                 # müşteri dashboard'u (layout: PanelProvider) + kullanicilar/
│   │   ├── _components/                  # UI (PanelShell, PanelDialogs, views/*View, ...)
│   │   │   ├── ErrorToasts.tsx           # cihaz komut hatası bildirimleri (SSE)
│   │   │   ├── DeviceControlModal.tsx    # cihaz paneli — Kontrol/Telemetri/Arıza geçmişi sekmeleri
│   │   │   ├── D4iPanel.tsx              # sürücü/LED telemetri detayı
│   │   │   ├── FaultHistory.tsx          # arıza geçmişi (fault_events)
│   │   ├── _lib/
│   │   │   ├── lighting.tsx              # LightingProvider: panel state + komutlar
│   │   │   ├── useLiveStatus.ts          # SSE (EventSource) hook
│   │   │   ├── mockData.ts / types.ts / format.ts
│   │   └── api/
│   │       ├── zones/route.ts            # GET /api/zones
│   │       ├── zones/[zoneId]/command|status/route.ts
│   │       ├── devices/route.ts
│   │       ├── devices/[deviceId]/command|status|fixtures|telemetry/route.ts
│   │       └── events/route.ts           # SSE (/api/events)
│   ├── lib/
│   │   ├── mqtt.ts                       # MQTT singleton (TLS) + publishCommand
│   │   ├── events.ts                     # in-memory event bus (MQTT→SSE)
│   │   ├── faults.ts                     # arıza kodu kataloğu (saf; client de kullanır)
│   │   ├── faultLog.ts                   # fault_events senkronu (yalnız değişimde yazar)
│   │   ├── auth/                         # token, password, session, dal, guard, rateLimit, roles
│   │   ├── tenancy.ts                    # bellek içi kiracı index'i
│   │   ├── audit.ts  summary.ts  customers.ts  zoneSlug.ts
│   │   ├── db/{schema,index,seed}.ts     # Drizzle
│   │   ├── env.ts  adapters.ts  api/respond.ts
│   └── types/lighting.ts                 # payload tipleri + zod kontrat
├── drizzle/                              # migration'lar
├── firmware/esp32-fener/                 # ESP32 Arduino sketch
├── scripts/mock-esp32.md                 # mosquitto_pub/sub test notları
├── docker-compose.yml                    # lokal postgres (opsiyonel)
└── CLAUDE.md
```

---

## Durum (2026-06)

Backend, DB, MQTT, SSE ve frontend entegrasyonu **tamamlandı ve Railway'de canlıda.**

- [x] PostgreSQL şeması (Drizzle migration, Neon)
- [x] MQTT broker (HiveMQ Cloud, TLS) — `src/lib/mqtt.ts` singleton
- [x] Zone/device API route'ları + SSE (`/api/events`)
- [x] Frontend gerçek API'ye bağlandı (komut + canlı durum)
- [x] Mock ESP32 entegrasyon testi (`scripts/mock-esp32.md`)
- [x] Deploy: Railway + Neon (Service Variables ile env)
- [x] Çok müşterili giriş + admin paneli (kod hazır; canlıya alma adımları aşağıda)
- [ ] Gerçek ESP32 sahada test (`firmware/esp32-fener/`)
- [ ] (İleride) LoRaWAN geçişi

### Deploy notları (Railway)
- `master`'a push → otomatik deploy (`npm run build` → `npm start`).
- Env değişkenleri Railway **Service Variables**'ta. `.env.local` deploy edilmez.
- **Replica = 1** (Kural #8). DB değişikliğinde lokalden `npm run db:migrate` (DATABASE_URL = Neon).
- **Çok müşterili sürümü ilk kez canlıya alma sırası:** (1) Railway'e
  `SESSION_SECRET` ekle, (2) `npm run db:migrate` (0006: "Meven ArGe" + backfill),
  (3) `npm run auth:create-admin -- <admin>`, (4) `master`'a push. Migration ile
  deploy arasındaki birkaç dakikada eski koddan bölge oluşturma başarısız olur
  (NOT NULL); diğer her şey çalışır.
