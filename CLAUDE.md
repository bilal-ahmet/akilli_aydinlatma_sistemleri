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
**Yalnızca binary protokol v1:** cihazlar ve ağ geçitleri bütün uplink'i binary basar (`Meven:<MAC>/bin`), backend bütün komutları binary gönderir. **JSON kabul edilmez ve gönderilmez** (2026-11-20'de kaldırıldı). Backend paketi çözüp iç JSON biçimine çevirir ve onu işler (`src/lib/binproto`, bkz. aşağıda "Binary protokol v1" ve `firmware/BINARY-ENTEGRASYON.md`).
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

**Dil: admin teknik, müşteri endüstriyel (ara seviye).** Admin her şeyi teknik
terimlerle görür (kanal/ch3, DALI, MAC, D4i, sürücü, ham firmware hata metni,
Teknik detay). Müşteri kullanıcıları (manager/viewer) iş hayatının endüstriyel
dilini görür — mühendislik kadar teknik değil, günlük de değil: "Armatür 3 /
Armatür numarası", "Cihaz kodu", "Ölçümler", "Sürücü ünitesi", "Şebeke
gerilimi", "Enerjilendirme sayısı", "Açık devre (bağlantı kopuk)", "Aşırı
ısınma: güç azaltıldı", "Cihaz meşgul: komut kuyruğu dolu". Kalıp: tanıdık kısa
başlık + gerekiyorsa endüstriyel ayrıntı. "Lamba" kelimesi UI'da **armatür**
olarak geçer (tüm rollerde; admin'in teknik kataloglarında DALI terimi "lamba
arızası" kalır). Teknik detay ve arc seviyeleri müşteriden gizli.
İstemcide `useTechnical()` (`_lib/panel.tsx`, `PanelInfo.technical = role === "admin"`),
kataloglarda `describeDeviceError(raw, { technical })` ve `faultLabel(code, technical)`
(teknik metin varsayılan; sunucu ve mobil kontratı değişmez), API hata
metinlerinde `msg(user, teknik, sade)` (`lib/api/respond.ts`). Yeni metin eklerken
müşteriye görünecekse bu ayrımı koru.

Müşteri metni ölçütü: belediyenin teknik/işletme personeli açıklama istemeden
anlamalı; gündelik ifade ("hiç", "kutu", "takılı lamba") kullanılmaz. İç kurallar
(0-63 aralığı, bağlantı numarası, toplu komut/topic), yer tutucular (`<numara>`)
ve efekt sıra numaraları müşteriye gösterilmez. Ölçümler sekmesinde müşteri
önce sade özeti (seviye, güç, enerji, sıcaklık, çalışma süresi, Durum) görür;
sürücü ünitesi/LED ayrıntıları ve arıza sayaçları kapalı "Ayrıntılar"dadır.

**Sayfalar:** `/login` · `/` (role göre yönlendirir) · `/admin` (müşteri kartları,
global acil komut) · `/admin/customers/<slug>` (bilgiler, pasifleştirme,
kullanıcılar, denetim kaydı) · `/hesap` (şifre değiştirme; ilk girişte zorunlu).

Müşteri paneli (tasarım: Claude Design "Fener Dashboard v2", kenar çubuklu):
`/c/<slug>` (Genel Bakış) · `/c/<slug>/bolgeler[/<zone>]` (bölge listesi +
detay) · `/c/<slug>/harita[?bolge=&direk=]` (direk haritası) · `/c/<slug>/cihazlar` ·
`/c/<slug>/arizalar[?bolge=]` · `/c/<slug>/raporlar` · `/c/<slug>/efektler` · `/c/<slug>/zamanlamalar` ·
`/c/<slug>/senaryolar` · `/c/<slug>/kullanicilar` (manager/admin).

**Senaryolar** (`views/ScenariosView.tsx`): sahada müşteriye anlatım için
canlandırma (Normal gece, Kaza, Sis, Yağmur, Gece tasarrufu). **Yalnızca
animasyon, hiçbir komut göndermez.** Tüm rollere açık. Simülasyon tek bir
`requestAnimationFrame` döngüsünde DOM'a doğrudan yazar; React yalnızca durum
satırını alır. Komut satırı admin'de teknik (efekt no, dim), müşteride sade.
Her senaryoda katalogdan efekt seçilir (`lib/effects.ts`; Kaza varsayılanı
Blink, diğerleri sabit ışık); efekt senaryonun olay anında çalışır (Normal
hemen, Kaza kaza süresince, Sis/Yağmur hava sürerken, Gece tasarrufu araç
yaklaşan direkte). Eğriler `_lib/scenarioFx.ts` — firmware kodundan değil
katalog açıklamalarından çıkarılmış yaklaşık görselleştirme; çok lambalı
efektler direkler arasında gösterilir (gerçekte cihazın kendi lambaları arası).

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
Meven:<MAC>/data   ← ESP32 publish, Backend subscribe (durum/telemetri + komut yanıtı)
Meven:<MAC>/health ← ESP32 publish, Backend subscribe (~30 sn: firmware sürümü, OTA durumu)
Meven:<MAC>/bin    ← ESP32 (yeni firmware) publish, Backend subscribe (QoS 2): binary protokol v1, TÜM uplink
Meven:<GW>/bin     ← Ağ geçidi (Border Router) publish: binary 0x03 (bkz. "Gateway'ler")
Meven:<GW>/lwt     ← Ağ geçidi bağlantı durumu, retained {"online":…} (abonelik +/lwt)
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
- **Bölge slug'ı = topic, global benzersiz, ≤32 karakter.** `all`, 12 haneli hex (MAC
  biçimi) ve `c-` öneki rezervdir (`isReservedZoneSlug`). Silinen bölgenin (ve
  alt grubun) slug'ı `retired_zone_slugs`'a yazılır ve **bir daha verilmez**: o
  slug ile flaşlanmış / NVS'inde tutan cihazlar topic'i dinlemeye devam
  edebilir, slug başka müşteriye verilseydi onun komutlarını alırdı. Alt grup
  slug'ları bölgelerle aynı ad alanındadır.
- Backend veri aboneliği `+/bin` (MQTT `+` joker'i `Meven:` ile aynı seviyeye
  gömülemez); MAC topic'ten okunur (`parseBinTopic`). `+/data` ve `+/health`'e
  yalnızca **görünürlük için** abone olunur: eski (JSON) firmware'in mesajı
  işlenmez, "JSON gönderen cihaz" olarak sayılır (`noteRejectedJson`,
  `GET /api/admin/binproto → jsonRejected`).
- **Not:** Bölge komutu SADECE `Meven:<slug>/cmd`'ye gider; backend MAC
  topic'lerine ayrıca fanout yapmaz. Eski firmware bölgesini `ZONE_SLUG`'tan
  bilir (flash'lanmamış cihaz bölge komutu almaz); yeni firmware listeyi
  NVS'te tutar ve panelden alır (aşağıda "Dinamik bölge aboneliği"). (Geçiş
  döneminde geçici MAC fanout'u vardı; kaldırıldı — cihazlar komutu iki kez
  alıyordu.)
- `Meven:<MAC>/cmd`'ye ayrıca bölge aboneliği komutları gider (zone_add /
  zone_remove / zone_clear / zone_list, yalnızca binary); alt grup topic'leri
  de `Meven:<grup-slug>/cmd` biçimindedir.

### Dinamik bölge aboneliği (zone sync) ve alt gruplar

Yeni firmware dinlediği bölge topic'lerini firmware'e gömülü `ZONE_SLUG`'tan
değil **NVS'ten** okur; liste panelden yönetilir (firmware ekibinin "Dinamik
zone ve bölgesel OTA" planı). Backend **komut kuyruğu değil istenen durum**
saklar ve cihazı ona getirir (`src/lib/zoneSync/`):

- **İstenen** = cihazın bölge slug'ı + üyesi olduğu **alt grupların** slug'ları
  (tenancy index'inden, DB'siz). Kayıtsız ama daha önce yönetilmiş MAC'te ∅
  (silinen cihaz/bölge → cihaz bağlanınca `zone_clear`).
- **Bilinen** = cihazın son doğrulanmış listesi, `device_zone_sync.reported`
  (NULL = bilinmiyor). Bilinmeyen cihaza ilk temas `zone_list`'tir.
- `plan.ts → planZoneOps` (saf) farkı hesaplar: önce çıkarmalar, sonra
  eklemeler (paket başına ≤3 slug); daha kısaysa `zone_clear` + eklemeler.
  **Cihaz başına tek komut uçuştadır**; ack gelince bilinen güncellenir, sıradaki
  hesaplanır — kayıp komut sırayı bozamaz. Ack'teki `zone_count` beklenenle
  uyuşmazsa liste yeniden okunur.
- Tetikleyiciler: CRUD sonrası `kick(macs)` (bellek içi, Kural #10), binary
  **HELLO** (3-15 sn jitter ile `zone_list` doğrulaması), cihazdan gelen her
  geçerli `/bin` paketi (iş kaldıysa). Ack 30 sn'de gelmezse aynı kısa id ile en
  fazla 3 deneme, sonra `no_response` (HELLO'da sürer). Aynı anda en fazla 8
  cihazda uçuşta komut.
- **Yalnızca binary ve yalnızca `Meven:<MAC>/cmd`** (cihaz başka topic'ten
  geleni -21 ile reddeder). Yalnızca binary paketi görülmüş cihaza gider
  (`binSeen`; açılışta DB'den tohumlanır), hiç bağlanmamış kayda değil. Eski binary
  firmware `zone_list`'e -5 döner → `unsupported`; health'te sürüm değişince
  yeniden denenir. -14/-15/-20 geri çekilmeli tekrar, -18/-19/-21 kalıcı hata
  (panelde görünür).
- Zone ack'leri lamba hatası değildir: `devices.last_error`, `fault_events`,
  `commands`'a yazılmaz (`mqtt.ts → handleZoneAck`); SSE `kind:"zone_sync"`
  (`zoneSync: {status, error}`) ile yayınlanır, toast olmaz.
- Mod `MQTT_ZONE_SYNC`: boş/`on` (varsayılan) · `observe` (yalnızca `zone_list`,
  fark `GET /api/admin/zone-sync`'te) · `off` (hiç zone komutu yok).
- **Alt grup** (`zone_groups`, `zone_group_members`): bölgenin cihazlarından ek
  topic. Slug = `<bölge>-<ad>` ASCII, **≤32**, bölgelerle aynı ad alanında global
  benzersiz, silinince `retired_zone_slugs`'a yazılır, değişmez (ad değişir).
  Cihaz başına bölge + en fazla 15 alt grup (firmware 16 sınırı). Bölge
  değişince cihaz eski bölgenin gruplarından çıkar.
- **Grup komutu** (`publishCommand("group")`, `POST /api/zones/:z/groups/:g/command`)
  tek publish'tir ama yalnızca grubu uygulamış (senkron) cihaza ulaşır. Bu
  yüzden panel (`planTargets(..., { groups: "synced" })`) ve zamanlayıcı
  (`runPlan`) tüm üyeler `synced` ise grup komutu, değilse üyelere cihaz komutu
  gönderir. Zamanlama hedefi `groups` saklar (karar çalışma anında).
- Yeni bölge slug'ları da **≤32** (`allocateZoneSlug`); 32'yi aşan eski slug
  cihaza gönderilemez, `GET /api/admin/zone-sync`'te listelenir.
- Panel: bölge detayında "Alt gruplar" kartı (`ZoneGroups.tsx`), seçim
  çubuğunda "Alt grup" (toplu ekle/çıkar), hızlı seçimde grup çipleri, cihaz
  satırında "Bölge bilgisi gönderiliyor/uygulanamadı", Bakım sekmesinde "Bölge
  bilgisi" + "Şimdi doğrula" (`DeviceZoneSync.tsx`). Admin sayfasında kart yok
  (kaldırıldı); genel durum `GET /api/admin/zone-sync`.
- Test: `npm run check:zonesync` (saf), `npm run mock:device <MAC> 2`
  (varsayılan 3 bölgeli NVS; `--zones a,b`, `--no-zones` = eski binary firmware).
- OTA bölge filtresi (`metadata.json → zones`) firmware/release aracındadır;
  backend'i ilgilendirmez — admin slug'ları alt grup kartında görür.

```
GET/POST        /api/zones/:zone/groups                 # liste (üyeler + senkron sayısı) / oluştur { name }
PATCH/DELETE    /api/zones/:zone/groups/:group          # ad / sil (slug emekliye, üyelere zone_remove)
POST            /api/zones/:zone/groups/:group/members  # { add?: MAC[], remove?: MAC[] } (bölgenin cihazları, 422)
POST            /api/zones/:zone/groups/:group/command  # Meven:<grup>/cmd (tek publish; yalnızca senkron üyelere)
GET             /api/groups?customer=<slug>             # müşterinin bütün alt grupları
GET/POST        /api/devices/:mac/zone-sync             # durum (admin: istenen + cihazdaki) / "Şimdi doğrula"
GET             /api/admin/zone-sync                    # mod, sayılar, senkron dışı cihazlar, kural dışı slug'lar
```

Guard `authorizeGroup` (tenancy; başka müşterinin grubu → 404). Audit:
`zone_group.create|update|delete|members`, `device.zone_verify`. `GET
/api/devices` cihaz başına `groups` (slug'lar) ve `zoneSync` döner.


### Binary protokol v1 (`Meven:<MAC>/bin`)

Firmware d4i_periodic, health, komut ack'i, commission sonucu ve HELLO'yu
kompakt binary paket olarak basar: `0x01` versiyon + `[alan kodu][değer]…`
+ CRC-16/CCITT-FALSE. d4i_periodic 2137 B'tan ≤170 B'a iner. **Tek kabul
edilen biçim budur**; JSON firmware desteği kaldırıldı (bkz. "JSON reddi"). Spesifikasyon: `firmware/MQTT-BINARY-PROTOKOL.html`
(firmware ekibi, rev 1.0). Entegrasyon notu: `firmware/BINARY-ENTEGRASYON.md`.

- **Çözücü backend'in içinde** (`src/lib/binproto`, saf). Python köprüsü
  (`mqtt_bridge.py`) ayrı servis olarak çalışmaz; çevirme kuralları ondan
  birebir porte edildi (`toJson.ts`).
- **Akış:** `lib/binUplink.ts → decodeBinUplink` (CRC, alan tablosu, iç JSON'a
  çevirme) → `mqtt.ts → routeUplink` (health / d4i_periodic) ya da
  `handleAck` (COMMAND_ACK). Aşağıdaki "Payload Formatları"ndaki JSON şekilleri
  bu iç biçimdir, kabloda değil.
- **Alan tablosu önce, OTA sonra.** `binproto/fields.ts`, firmware'deki
  `msg_fields.h`'nin kopyasıdır. Tanımsız alan kodu taşıyan paket tamamen
  atılır; sayaç ve alarm `GET /api/admin/binproto`'dadır (admin sayfasındaki
  kart kaldırıldı). Firmware yeni alan eklerse önce tablo +
  `npm run check:binproto` + deploy, sonra OTA.
- **Bütün komutlar binary** (`publishCommand`, `publishMaintenance`,
  zone ve gateway komutları; `lib/binproto/command.ts → encodeCommand`).
  Tek cihaz, bölge, alt grup, müşteri "Tüm Sistem"i ve `Meven:all/cmd`
  aynı paketi alır; topic başına biçim seçimi ve `MQTT_BINARY_COMMANDS`
  kapatma anahtarı kaldırıldı. Binary komuta cihaz `/bin`'e binary ack döner.
- **JSON reddi:** `Meven:<MAC>/data` ve `/health`'e gelen JSON (eski firmware)
  işlenmez: `last_seen`, telemetri, ack, health yazılmaz; cihaz panelde
  bağlantısız görünür. `lib/binUplink.ts → noteRejectedJson` MAC'i sayar,
  `GET /api/admin/binproto` `jsonRejected` olarak listeler, sunucu
  logu saatte bir uyarır. HELLO metni (`"data"`) sayılmaz. Böyle bir cihaz
  komut da alamaz (binary komutu çözemez): firmware güncellenmeli.
- **Kısa komut id'si:** binary'de `COMMAND_ID` u16'dır, UUID kabloya çıkmaz.
  Backend genelinde TEK dönen sayaç (`binproto/shortIds.ts`, rastgele başlangıç,
  0 atlanır, 10 dk TTL) — cihaz başına değil, çünkü bölge komutu tek id ile çok
  cihaza gider. Binary ack'in id'si UUID'ye çevrilip `handleAck`'e verilir;
  DB/API/SSE/mobil UUID'yi görmeye devam eder. **Eşlenemeyen ack'te "en son
  bekleyen komut" tahmini yapılmaz**; hata yine rozete ve arıza geçmişine
  yazılır. Python köprüsü canlı broker'da yalnızca `--watch` / `--compare`
  ile çalıştırılır.
- **Bir-kezlik health alanları** (`idf_version`, derleme zamanı, Thread ağ adı)
  bağlantı başına bir kez gelir; cihaz başına bellekte tutulur. Önbellek boşsa
  `devices.health`'ten tohumlanır.
- **Rapor aralıkları** (`0xB9 health_interval_s`, `0xBA report_interval_s`,
  saniye) yalnızca **ilk kayıtta (join)** gelir. Önbelleğe değil
  `devices.health_interval_s / report_interval_s` sütunlarına yazılır
  (`handleHealth`; gelmediği mesajda ezilmez). Bkz. "Cihaz başına pencereler".
- **JSON aynası (izleme):** `MQTT_JSON_MIRROR=all` (ya da virgüllü MAC
  listesi) verilirse çözülen her paketin JSON karşılığı (Python köprüsü
  çıktısının aynısı; ack'te u16 id) `Meven:<MAC>/json/data|health`'e,
  reddedilen paketin nedeni + hex'i `Meven:<MAC>/json/reject`'e basılır.
  İzlemek için `+/json/#`. Varsayılan kapalı. Backend'in ürettiği bir
  izleme akışıdır, cihazdan JSON almak değildir. Topic bilerek `/data`,
  `/health` değil: backend oraları dinler, kendi aynasını "JSON gönderen
  cihaz" sayardı.
- **Yok sayılanlar:** ilk bayt `0x02` LoRa gateway protokolüdür (henüz
  desteklenmez, sayılır). Binary HELLO `/bin`'e gelir (bölge senkronu
  tetikleyicisi); eski firmware'in `/data`'ya bastığı düz `"data"` metni
  yok sayılır. `dali_status`, `d4i` (tek bank) ve `commission_result` tipleri
  sessizce atlanır (`parseUplink → kind:"ignored"`).
- **Python'dan sapmalar:** eksik zorunlu alan paketi `MISSING_FIELD` ile
  reddettirir (Python'da köprü çöküyor). Maskeli `load_power` `value: null`
  olur (Python 4294967295 W yazıyor).

### Gateway'ler (ağ geçitleri) — binary 0x03

Sahadaki Thread Border Router'lar (ileride 4G/WiFi/LoRaWAN) lambalarla **aynı
topic şemasını** kullanır ama verilerini **yalnızca binary** basar: paketin
ilk baytı **0x03** (lamba 0x01). GW_ID = Wi-Fi STA MAC (`Meven:` öneki kimliğe
dahil değil). Kontrat: `firmware/GATEWAY-ENTEGRASYON.md`; alan tablosu ve
örnek paketler: `firmware/BR-BINARY-PROTOKOL.md` (firmware ekibinin belgesi).
**JSON gateway kontratı kaldırıldı**: `/data|/health`'e gelen JSON işlenmez
("JSON gönderen cihaz" sayılır), kayıtlı gateway kimliğinden gelen 0x01
paketi `GATEWAY` ile reddedilir. `/lwt` JSON'u (`{"online":…}`) veri değil,
MQTT will mesajıdır; kalır.

```
Meven:<GW_ID>/bin  ← 0x03: BR_HEALTH (bağlanınca + ~300 sn), BR_NEIGHBORS + BR_ROUTES
                     (bağlanınca + ~900 sn, sayfalı, aynı SNAPSHOT_ID), COMMAND_ACK
Meven:<GW_ID>/lwt  ← retained {"online":true}; MQTT will {"online":false}  (abonelik +/lwt, QoS 2)
Meven:<GW_ID>/cmd  → 0x03 COMMAND: report_now (6) | ota_check (5), u16 kısa id
```

- **Çözücü:** `binproto/codec.ts` ilk bayta göre tablo seçer (0x01 `fields.ts`,
  0x03 `brFields.ts`). `binUplink.ts → decodeBrUplink` sayaç/alarmı lambayla
  paylaşır ama cihaz binary durumuna (`binSeen`, admin cihaz listesi)
  yazmaz; BR retleri "BR" önekli. Çeviri `brToJson.ts` (saf): health zarfı
  (`fw`, `uptime_s`, `uplink{kind:"wifi",…}`, `thread{…, partition_id: metin,
  pan_id:"0x…"}`, `counters` (son health'ten fark), `ota`), topoloji sayfası,
  ack. Bağlantı başına bir kez gelen alanlar (B3, B4, B9, BA, CA) gateway
  başına bellekte; boşsa `gateways.health`'ten tohumlanır.
- **Akış:** `mqtt.ts → handleBrUplink`. Kayıtsız GW_ID → veri yazılmaz,
  `lib/gatewayDiscovery.ts` "Keşfedilen ağ geçitleri"ne `thread_br` olarak
  düşer (tür sürüm baytından kesin). Kayıtlıysa: health → `gateways.health`,
  `firmware_version`, `last_seen`, `online:true`, `noteHealth` (OTA koruması),
  lamba bağı; topoloji → `brTopology.ts` birleştiricisi (tekrar sayfa bir kez,
  yarım tur 2 dk'da atılır) tamamlanınca `gateways.report.{neighbors,routes}`;
  ack → `settleCommand` + SSE `kind:"gateway"` `gatewayCommand` (lamba
  hatası değil: rozet/arıza/toast yok). LWT yalnızca `online`'ı yazar,
  `last_seen`'i ilerletmez (`presenceOnly`). Zone sync kancalarına girmez.
- **Lamba bağı (`lib/gatewayLink.ts`):** 0x03'te `nodes` yok. Gateway health'indeki
  `thread.partition_id` = lambanın `devices.health.thread.partition_id` →
  `devices.gateway_id` (yalnızca gateway'in müşterisi; aynı partition'ı
  bildiren başka gateway'e bağlı cihaza dokunulmaz; partition'ı değişen ya da
  müşteri değiştiren cihazın bağı kalkar; partition'sız cihazın bağı kalır).
  Her gateway health'inde iki UPDATE, yalnızca değişen satır.
- **Çevrimiçi:** `gatewayOnlineWindowMs(health)` = `max(2 dk, 2,5 ×
  health_interval_s)`, `GatewayView.onlineWindowMs`; `gatewayState` bunu kullanır.
- **Komutlar:** `publishGatewayCommand` (senkron, DB'siz) + `recordGatewayCommand`
  (`commands.target_type = 'gateway'`). `report_now` admin + manager,
  `ota_check` yalnızca admin + `otaRepeatBlock` (meşgul / son 3 dk → 409).
  UI: `GatewayMaintenance.tsx`. Hata metni `gatewayCommandErrorText` (teknik/sade).
- **Panel:** alanlar `summarizeGateway` ile sunucuda role göre (müşteri:
  çalışma süresi, internet bağlantısı, sinyal, armatür ağı; admin: Thread,
  sistem, sayaçlar, OTA). Admin'e `GatewayView.topology` (`GatewayTopology.tsx`;
  RLOC16 aynı müşteri + partition'daki lambanın health'indeki `thread.rloc16`
  ile adlandırılır) ve ham `raw`.
- Gateway `Meven:all/cmd`'ye ve bölge topic'lerine abone olmaz.
- Aynı MAC hem cihaz hem gateway olamaz (iki yönde 409). Ağ geçidi olan müşteri
  silinemez; bölge başka müşteriye taşınınca o bölgenin gateway/cihaz bağları
  kaldırılır.
- Test: `npm run check:binproto` (belgedeki 5 örnek paket, komut baytları,
  birleştirici), `npm run mock:gateway <GW_ID> --partition <n> [--interval s]
  [--rlocs 5C01,…]`, `npm run mock:device <MAC> 2 <bölge> --partition <n> --rloc <n>`.

### QoS Seviyeleri

Tek yer: `src/lib/topics.ts → CMD_QOS`, `UPLINK_QOS` (2026-11-20'de 1 → 2).

- **Backend → cihaz / ağ geçidi** (komut, bakım, zone, gateway komutu, bütün
  `…/cmd` topic'leri): **QoS 2** — tam bir kez iletim.
- **Cihaz / ağ geçidi → backend** (`+/bin`, `+/lwt` aboneliği): **QoS 2**.
- Eski JSON topic'leri (`+/data`, `+/health`, yalnızca görünürlük) ve JSON
  aynası: QoS 0.

> **Etkin QoS = min(yayınlayanın QoS'u, abonenin QoS'u).** Backend'in 2
> istemesi yalnızca kendi tarafındaki üst sınırdır. Uçtan uca QoS 2 için
> firmware komut topic'lerine (`Meven:<MAC>/cmd`, bölge/alt grup, `all`)
> QoS 2 ile **abone olmalı**, `/bin`'i (ve ağ geçidi `/lwt` + will'i) QoS 2
> ile **basmalıdır**; aksi halde o yön firmware'in QoS'unda kalır. Kalıcı
> oturum (clean session = false) yoksa QoS 2 de çevrimdışı cihaza saklanmaz.
> Bedeli: mesaj başına 4 paketlik el sıkışma; Thread ağında özellikle bölge
> komutunun fan-out'unda trafik artar.

---

## Payload Formatları

### Command Payload (Backend → ESP32, `Meven:<MAC>/cmd` veya `Meven:all/cmd`)

> Kabloda **binary** gider (`encodeCommand`, u16 kısa id). Aşağıdaki JSON
> komutun mantıksal alanlarını gösterir; binary paket aynı alanları taşır.

```json
{ "action": "dim", "value": 75, "channel": 3, "id": "51f2d445-ec29-42d7-a2a9-901682322c49" }
```

`action` değerleri: `"on"` | `"off"` | `"dim"` | `"efekt"` (+ bakım: `"commission"` | `"ota_check"`, aşağıda)
`value`: 0–100 arası integer (yalnızca dim için kullanılır)
`channel`: hedef **DALI kanalı (lamba)** — 0–63. Bir ESP'ye birden çok bağımsız
aydınlatma bağlanabilir; her biri bu kanal no ile ayrı sürülür. Firmware 1.0.9
sahada cihaz başına en fazla 5 lamba, kanal **0–4** kullanır (taramada atanır).
`id`: komut kimliği = `commands.request_id`. `publishCommand` publish'ten ÖNCE
üretir ve **her** komuta koyar; cihaz yanıtında aynen geri yollar (bkz. Komut
yanıtı). Bölge/"Tüm Sistem" komutunda tek id vardır; toplu komuta cihaz
başarı cevabı dönmez (bkz. Komut yanıtı).
Kabloda UUID yerine u16 kısa id gider (bkz. Binary protokol v1).

> **⚠ TÜM LAMBALAR = `channel` alanını HİÇ GÖNDERME.** Toplu komutlarda (cihazın
> "Tüm cihaz"ı, bölge, "Tüm Sistem") payload'da `channel` **bulunmaz**; cihaz
> alanın yokluğundan tüm lambaları anlar. Bir dönem bunun için DALI broadcast
> adresi (255) gönderiliyordu — **firmware bunu artık reddediyor**
> (`"bilinmeyen action"`), o yüzden 255 tamamen kaldırıldı (`wireChannel`).
> API kontratı zaten aynıydı: `channel` yokluğu = tüm cihaz. Sahada doğrulamak
> için: `npm run watch:cmd`.

**Bakım komutları (firmware 1.0.9+):** `{ "action": "commission", "id": "…" }`
(DALI taraması: adressiz yeni lambalara boş kanal verir, ışık değişmez) ve
`{ "action": "ota_check", "id": "…" }` (OTA kontrolü; yeni sürüm varsa cihaz
indirip **yeniden başlar**). YALNIZCA `Meven:<MAC>/cmd`'ye gider
(`publishMaintenance`, `POST /api/devices/:mac/maintenance`); bölge/`all`
karşılığı yoktur (Kural #17). Işık `ACTIONS`'ına girmez → snapshot'a dokunmaz.
`"ok"` yanıtı yalnızca **kabul** demektir: tarama sonucu `d4i_periodic`
raporlarıyla (yeni kanal → `upsertFixture`), OTA ilerlemesi `/health` ile gelir.
Tarama admin + manager, OTA yalnızca admin. UI: cihaz modalinin **Bakım**
sekmesi (`_components/DeviceMaintenance.tsx`).

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
efekti başlatmaz — toplu komuta cevap dönmediği için hatası panelde görünmez). Cihaz ayrıca aynı anda en fazla 4 kanalda efekt çalıştırır
— dolduğunda `efekt baslatilamadi (bos slot yok…)` döner.

**Çok lambalı efekt cihaz geneli durur.** Böyle bir efekt çalışırken bir lambada
yapılan her işlem (efekti durdur, aç/kapa, şiddet, tek lamba efekti) efekti önce
cihazın TAMAMINDA durdurur: `DeviceControlModal` kanalsız `dim` (son "Tüm cihaz"
şiddeti) gönderir, lamba komutu bu isteğin yanıtını bekleyip ardından gider
(iki POST paralel gitseydi sıra bozulabilirdi). Sunucu da aynı kuralı snapshot'a
uygular (`recordCommand`): kanal taşıyan allLamps efekti tüm lambalara yazılır,
allLamps efektindeki lambaya gelen kanal komutu diğer lambaların `active_fx`'ini
temizler (`clearGroupEffect`) — mobil/API istemcileri de tutarlı kalır.

**Toplu kontrol (seçili cihaz/lamba).** Bölge detayı ve Efektler sayfası aynı
seçim modelini kullanır (`app/_lib/selection.ts`, saf): `Selection = Map<MAC,
null | Set<kanal>>` — `null` cihazın tamamı, `Set` yalnızca o lambalar.
- **Bölge detayı:** cihaz tablosunda onay kutuları (çok lambalı cihaz "›" ile
  lamba lamba açılır), üstte Tümü / Açık olanlar / Kapalı olanlar / Temizle
  (`SelectionQuickBar`), seçim varken altta sabit çubuk: Aç · Kapat · Şiddet ·
  Efekt · Efekti durdur (`SelectionActionBar`).
- **Efektler sayfası:** "Nerede çalışsın?" bölge çipleri + "Cihaz ve lamba
  seç…" penceresi (aynı tablo, `DeviceTable compact`), altta sabit
  efekt + hedef + Başlat/Durdur çubuğu.
- **Komut planı tek yerde:** `planTargets` / `planStop`. Kurallar:
  - Bölgenin bütün cihazları tamamen seçiliyse tek bölge komutu gider (Kural #3).
  - Efektlerde her şey seçiliyse "Tüm Sistem" isteği gider.
  - Cihazın tamamı seçiliyse kanalsız komut, kısmi seçimde lamba başına
    kanallı komut gider.
  - Çok lambalı efekt lamba seçimini cihazın tamamına yükseltir; `minLamps`'i
    karşılamayan cihaz atlanır ve kullanıcıya bildirilir.
- **Çok lambalı efekt çalışan cihaz:** lamba komutundan önce efekt kanalsız
  `dim` ile cihazın tamamında durdurulur. Komutlar `LightingProvider`'da
  cihaz başına sıraya girer (`deviceChains`); fonksiyonlar `setTargetsPower`,
  `setTargetsBrightness`, `applyEffect` / `stopEffect` (`EffectTarget`
  `lamps` de alır).
- **Lamba durumu:** `GET /api/devices` her cihaz için `lamps[]` (fixtures
  snapshot'ı) ve `lampCount`, `activeFx` döner. İstemci bunları optimistic
  günceller ve SSE'deki kanallı komut/telemetri olaylarıyla senkronlar.
  Şiddeti 0 olan lamba, efekt çalışmıyorsa kapalı sayılır (`lampOn`).

**Zamanlanmış komutlar (Zamanlamalar).** Seçilen saatte bölgelere, seçili
cihaz/lambalara ya da tüm bölgelere Aç (isteğe bağlı şiddetle) · Kapat · Şiddet ·
Efekt · Efekti durdur. Çalıştıran **sunucudur** (`lib/scheduler.ts`), tarayıcı
açık olmak zorunda değil.
- **Zaman:** tek sefer (tarih) ya da haftalık (gün bit maskesi, Pzt=1 … Paz=64);
  sabit saat ya da gün batımı/doğumu ± dk. Saatler Türkiye saatidir
  (`SCHEDULE_TZ`); gün batımı Kocaeli koordinatıyla kütüphanesiz hesaplanır
  (`lib/sun.ts`, NOAA, ±1-2 dk). Hesap tek yerde: `lib/scheduleTime.ts →
  nextRunAt` (saf; formdaki "Sonraki çalışma" önizlemesi de bunu kullanır).
  Türkiye 2016'dan beri kışın da UTC+3: Aralık'ta gün batımı ~17:36.
- **Hedef = `planTargets` çıktısı** (`{zones, devices, lamps}` ya da
  `{all:true}`), kayıtta istemcide hesaplanır. Bütün cihazları seçili bölge bölge
  olarak saklanır → bölgeye sonradan eklenen cihaz da komutu alır.
- **Yürütme:** `lib/commandPlan.ts → runPlan`, istemciyle aynı kurallar:
  sahiplik süzgeci (taşınmış/silinmiş hedef atlanır), çok lambalı efektte
  lamba → cihaz yükseltmesi + `minLamps` elemesi, grup efekti çalışan cihazda
  önce kanalsız `dim` sonra lamba komutu, "Efekti durdur" yalnızca efekt
  çalışan hedeflere. Her komut `publishCommand` + `recordCommand` (commands
  logu, SSE; `userId` = zamanlamayı kuran).
- **Zamanlayıcı:** bellekte `next_run_at` haritası, en yakına tek `setTimeout`
  (en fazla 6 sa). **DB yoklanmaz** (Neon uyumaya devam eder). Çalıştırma
  atomik claim'le: `UPDATE … WHERE next_run_at = <beklenen>` — deploy sırasında
  eski + yeni instance birlikte yaşasa da komut bir kez gider. Sunucu
  kapalıyken kaçırılan çalışma 15 dk içindeyse hemen çalışır, daha eskiyse
  `last_result.missed` yazılıp atlanır. CRUD sonrası `reloadSchedules()` yanıt
  dönmeden beklenir.
- **UI:** `views/SchedulesView.tsx` (liste, duraklat, düzenle, sil),
  `ScheduleForm.tsx` (`useDialogs().openSchedule({ prefill })`). Bölge
  detayındaki seçim çubuğunda ve Efektler alt çubuğunda "Zamanla" kısayolu
  mevcut seçimle formu açar. Hedef seçimi Efektler'le ortak:
  `_components/TargetSelect.tsx` (`TargetChips`, `TargetPicker`).

**Mors efekti (no 22):** ek `text` alanı alır —
`{ "action": "efekt", "number": 22, "text": "MERHABA" }` (tek lambaya verilecekse
ek olarak `"channel": 3`).
Harf, rakam ve boşluk; en fazla 32 karakter (`MORSE_TEXT_MAX`). `text`
gönderilmezse cihaz **son ayarlanan metni** tekrar çalar; bu yüzden boş string
gönderilmez, alan payload'a hiç konmaz. Girdi `normalizeMorseText` ile indirgenir
(Türkçe harfler ASCII'ye: Ş→S, desteklenmeyen karakterler atılır) — hem
dashboard'da anlık, hem `commandRequestSchema`'da sunucu tarafında.

### Data Payload (ESP32 → Backend, `Meven:<MAC>/bin` → iç JSON)

Cihaz binary basar; aşağıdaki JSON şekilleri çözülmüş paketin **iç** biçimidir
(`lib/binproto/toJson.ts`). İki tür vardır; ayrım `src/types/lighting.ts` →
`parseUplink` içinde yapılır. MAC topic'ten çözülür (`parseBinTopic`).

**1. Komut yanıtı** — cihaz tekil (`Meven:<MAC>/cmd`) komuttan sonra sonucu yayınlar:

> **Toplu komuta (bölge, "Tüm Sistem", `Meven:all/cmd`) cihaz cevap DÖNMEZ**
> (firmware kararı: yüzlerce cihazın aynı anda cevabı Thread ağını tıkar).
> Yanıt yalnızca `Meven:<MAC>/cmd` komutlarına gelir. Toplu komutun `commands`
> satırı cihazın sonraki telemetrisiyle `delivered` olur (`markDelivered` →
> `commandTargets`: MAC, bölge, müşteri, `all`). Firmware toplu komutta
> yalnızca hata cevabını rastgele gecikmeyle göndermeye karar verirse id ile
> bölge komutuna bağlanır (kod hazır); vermezse toplu komut hataları (ör.
> yetersiz lambalı efekt) panelde görünmez.


```json
{ "action": "dim", "id": "51f2d445-…", "status": "ok" }
{ "action": "dim", "id": "51f2d445-…", "status": "error", "error": "bilinmeyen action" }
```

Hata metni SSE ile dashboard'a gider: sağ altta bildirim + cihaz kartında rozet
(`devices.last_error`, sonraki `ok` yanıtında temizlenir). Yanıt **`id` ile o
komuta** bağlanır (`commands.status` → `delivered` / `failed`) ve komutun
`channel`'ı olaya eklenir. Kısa id eşlenemezse komut tahmin edilmez.

> **Ack, `commands` satırından önce gelebilir** (INSERT `after()`'ta, Kural #10).
> Bu yüzden `publishCommand` id'yi bellek içi `inflight` haritasına yazar
> (kanal + bakım türü, ~10 dk TTL); satır yoksa sonuç oraya bırakılır ve
> `insertCommandRow` INSERT'te onu kullanır. Bakım yanıtları (`commission`,
> `ota_check`) rozete / `fault_events`'e YAZILMAZ; SSE'ye `kind:"maintenance"`
> olarak gider ve yalnızca Bakım sekmesinde gösterilir (`ErrorToasts` atlar).

Ham metinler `src/lib/deviceErrors.ts` kataloğunda okunur başlık + sebebe
çevrilir (`describeDeviceError`); UI ham metin yerine bunu gösterir. "Ne
yapılmalı" ipucu bilinçli olarak YOK — arıza ve hata ekranları yalnızca durumu
gösterir.
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
Binary protokolde `bank_206_raw_hex` **kaldırıldı**, panel yokluğunu tolere eder.
Ham bank gerekirse `d4i_read` ile istenir.

> **`d4i_telemetry.led_voltage_v / led_current_a / led_temperature_c` sütunları
> yalnızca DOĞRULANMIŞ değeri taşır**, yani yeni firmware'de çoğunlukla NULL'dur.
> Panel bu yüzden ölçümleri sütunlardan değil `raw`'dan okur. Tahminler üzerinden
> grafik gerekirse ayrı `*_estimated_*` sütunları + migration eklenmeli.

Arıza sayaçları 1 baytlıktır ve tavana ulaşınca saymayı bırakır; firmware bunu
`<key>_count_saturated: true` + `<key>_count_text: "253+"` ile bildirir
(`readCounter`). Panel `253` yerine `253+` yazar — sayaçlar birbirinden
bağımsızdır, `general_failure_count` diğerlerinin toplamı **değildir**.

> **Eski JSON rapor kontratı** (`deviceId` + `brightness`/`relayStatus`/
> `channels[]`) 2026-11-20'de kaldırıldı. `device_status` tablosu ve onu
> okuyan uçlar yalnızca eski kayıtlar için durur; yeni satır yazılmaz.

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
PATCH  /api/devices/:deviceId    → bölge / isim / MAC güncelle { zoneSlug?, name?, mac? }
DELETE /api/devices/:deviceId    → cihazı ve tüm kayıtlarını sil
```

> **Bölge değişikliği:** dinamik bölge aboneliğini destekleyen (yeni)
> firmware'de yeni bölge cihaza gönderilir (zone sync; çevrimdışıysa HELLO'da),
> cihaz eski bölgenin alt gruplarından çıkarılır. **Eski firmware'de** cihazın
> hangi `Meven:<slug>/cmd` topic'ini dinlediği `ZONE_SLUG`'tan gelir; cihaz
> yeniden flaşlanana kadar eski bölgenin toplu komutlarını almaya devam eder.
> Tekil (MAC) ve `Meven:all/cmd` komutları etkilenmez. Dashboard uyarıyı cihazın
> `zoneSync` durumuna göre seçer. Cihaz silinince istenen liste ∅ olur →
> bağlandığında `zone_clear`.
> **MAC düzeltmesi** (`mac`, yalnızca yanlış girilmiş kod için): cihazın kimliği
> MAC olduğundan bütün kayıtları yeni MAC'e taşınır (`lib/deviceRename.ts →
> renameDeviceMac`, tek transaction). Taşınanlar: `fixtures`, `d4i_telemetry`,
> `device_status`, `device_health_log`, `fault_events`, cihaz `commands` logu ve müşterinin
> zamanlama hedefleri. Kayıtsız MAC'in verisi de yazıldığı için yeni MAC'te
> gerçek cihazın lamba satırları zaten olabilir: aynı kanalda yeni MAC'in
> satırı kalır, eski satırdan yalnızca isim aktarılır. Son görülme, sağlık,
> sürüm ve gateway bağı sıfırlanır; cihazın ilk mesajıyla dolar. Eski MAC'te
> kayıt kalmaz. Yeni MAC başka cihaz ya da gateway olarak kayıtlıysa 409
> (sahip açıklanmaz). Audit: `device.mac_change`.
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
GET    /api/devices/:deviceId/telemetry         → kayıtlı armatür başına son D4i raporu (+ `stale`)
GET    /api/devices/:deviceId/faults?limit=100  → arıza geçmişi (süren + çözülen)
```

> **Panel telemetrisi yalnızca `fixtures`'ta kayıtlı kanalları** gösterir:
> silinen armatürün `d4i_telemetry` geçmişi (raporlar için) kalır ama panelde
> görünmez; silmede süren arızaları da kapatılır (`syncFaultEvents(…, [])`).
> Son raporu **7 günden eski** (`TELEMETRY_STALE_DAYS`, `lib/deviceWindows.ts`)
> armatürün ölçümleri `data`'ya girmez, `stale: [{channel, lastReportAt}]`
> olarak döner; panel "N gündür ölçüm gelmediği için…" uyarısı gösterir. Kayıt
> cihaza bağlı kalır, yeni rapor gelince ölçümler geri gelir.

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
cihazın tazelik penceresi içinde) toplar: çekilen güç, yük gücü, ortalama LED gerilimi (**gerilim
toplanmaz**) ve `fault_events`'ten açık arızası olan **farklı lamba** sayısı.
Ölçüm yoksa `powerW: null` döner ve dashboard direk sayısına dayalı tahmine
düşer. Değerler ham `raw` bloğundan `lib/d4i.ts` ile okunur — panelle aynı
doğrulanmış → tahmini → ham kuralı. Yanıt ayrıca `devices` (MAC → aynı
ölçümler) kırılımını taşır; cihaz tablosu ve bölge detayı (istemcide
cihazlarından toplanır) bunu kullanır. Penceresinde rapor vermeyen cihaz
kırılımda yoktur → panelde "Veri bekleniyor".

**Cihaz başına pencereler** (`lib/deviceWindows.ts`, saf). Sahadaki cihazlar
~30 sn'de bir göndermez; firmware aralıklarını ilk kayıtta bildirir
(`devices.*_interval_s`). Bildirmeyen cihaz (eski firmware, ~30 sn) eski
sabitlerle değerlendirilir:
- **Çevrimiçi:** `max(3 dk, 2,5 × min(health, rapor aralığı))` — `last_seen`
  her mesajla tazelendiği için en sık gelen mesaja bakılır. Sunucu
  `GET /api/devices`'ta `onlineWindowMs` (+ `healthIntervalS`,
  `reportIntervalS`) döner; `deviceHealth.ts → isOnline` bunu kullanır
  (yoksa 3 dk), `poleState`, `countLamps`, sayaçlar ve harita da.
  Admin müşteri listesindeki "çevrimiçi" sayısı aynı kural (`lib/customers.ts`).
- **Ölçüm tazeliği:** `max(10 dk, 2,5 × rapor aralığı)` (`computeSummary`).
- Admin cihaz modalı → Bakım: "Rapor aralığı" satırı.

```
GET /api/faults             → süren lamba arızaları (cihaz + bölge bilgisiyle)
GET /api/faults?days=30     → + son N günde (1-90) çözülenler (id, resolvedAt)
GET /api/faults?zone=<slug> → yalnızca o bölge (days ile birlikte de kullanılır)
```

Arıza kaydının kategorisi (`faultCategory`: bağlantı / lamba / sürücü / LED /
komut), durum açıklaması (`faultDescription`, teknik + sade; ipucu yok) ve
uyarı mı arıza mı (`isWarningCode`) `lib/faults.ts`'te; `openAlerts` bunları
`AlertItem`'a koyar. Arızalar sayfası ve bölge detayı aynı kartları kullanır
(`_components/FaultItems.tsx`). Lamba rozeti (`fixtures.status`) ve bölge
durumu da `activeFaultCodes`'tan karar verir — arıza geçmişiyle aynı liste.

### Ağ geçitleri (gateway)

```
GET/POST         /api/gateways?customer=<slug>   # liste / kayıt { gatewayId, type, name?, zoneSlug?, location?, notes? }
GET/PATCH/DELETE /api/gateways/:gatewayId        # PATCH: type, name, zoneSlug ("" = bağı kaldır), location, notes
POST             /api/gateways/:gatewayId/command # { action: report_now | ota_check } → 202 { requestId }
GET              /api/admin/gateways/discovered  # (admin) yayın yapan kayıtsız GW_ID'ler, bellek içi, 24 sa
```

Guard: `authorizeScope` / `authorizeGateway` (başka müşterinin gateway'i → 404).
CRUD admin + manager, viewer okur. Kimlik (GW_ID) ve müşteri değiştirilemez.
Audit: `gateway.create` / `gateway.update` / `gateway.delete` / `gateway.report_now` / `gateway.ota_check`. Panel:
`/c/<slug>/ag-gecitleri` (`views/GatewaysView.tsx`, liste bu sayfaya özel;
canlı durum SSE `kind:"gateway"` olayıyla). Donanımsız test:
`npm run mock:gateway <GW_ID> --partition <n>` (binary 0x03).

### Direkler ve harita

Direk = sahadaki fiziksel direk, konumuyla (`poles`). **Bir direkte tek cihaz
(ESP)**; direğin lambaları o cihazın `fixtures`'ıdır, ayrıca bağlanmaz
(`devices.pole_id` UNIQUE). Direk cihazdan önce var olabilir (envanter içe
aktarılır, cihaz sonra takılır) ve cihaz değişse/MAC düzeltilse de kalır.

```
GET/POST         /api/poles?customer=<slug>[&zone=<slug>]   # liste / oluştur
GET/PATCH/DELETE /api/poles/:poleId                         # konum, numara, ad, not, bölge, cihaz
POST             /api/poles/import?customer=<slug>           # CSV / GeoJSON; apply:false → önizleme

Body: { zoneSlug, code, name?, lat?, lng?, locationSource?: map|manual|gps|import,
        locationAccuracyM?, notes?, deviceMac? ("" = bağı kaldır) }
```

- Kurallar tek yerde: `lib/poleStore.ts` (`setPoleDevice`, `poleCodeTaken`).
  Numara **müşteri içinde** benzersiz (harf duyarsız). Cihaz ile direk aynı
  bölgede olmalı (422); başka direğe bağlı cihaz 409. Cihazlı direğin bölgesi
  değişmez (önce `deviceMac: ""`). Cihaz başka bölgeye taşınınca bağ kalkar;
  cihaz `PATCH`'i `poleId` de alır. Direk silinince cihaz kalır.
- Müşteri bölgeden türetilir (`poles.customer_id` yok): bölge taşınınca
  direkleri de gider, bölge silinince silinir. Guard `authorizePole`
  (DB'den, başka müşteri → 404). Audit `pole.create|update|delete|import`.
- Konum WGS84 ondalık derece; `lat`+`lng` birlikte. Kaynak verilmezse
  `manual`; konumu değişmeyen PATCH'te gönderilmez (GPS/içe aktarma kaynağı
  korunur). Komut yolu değişmez: direk komutu = cihazın MAC komutu.
- **Durum** `app/_lib/poles.ts → poleState` (saf, mobil kopyası var):
  `no_device → offline (cihazın penceresi, varsayılan 3 dk) → fault (uyarı olmayan lamba arızası ya da komut
  hatası) → on / off`. Envanter "Yanan direk", Genel Bakış ve harita bunu kullanır.
  "Yanan lamba" da aynı kuralla sayılır (`deviceHealth.ts → countLamps`): bağlantısız
  cihazın lambaları son komutun durumunda donduğu için yanan değil "bağlantısız" sayılır.
  Bölgede kayıtlı direk yoksa elle girilen `zones.pole_count` yalnızca sayı
  olarak gösterilir (`zonePoleCount`); direk sayısından güç tahmini yok.
- **İçe aktarma** (`lib/poleImport.ts` saf ayrıştırıcı): CSV (`;` `,` sekme,
  ondalık virgül, Türkçe başlıklar: kod, enlem, boylam, bölge, cihaz, ad, not)
  ve GeoJSON Point. Numara ile upsert; boş hücre mevcut değeri silmez. Hatalı
  satır varsa **hiçbir şey yazılmaz**. Türkiye kutusu dışındaki koordinat
  reddedilir — belediye CBS verisi çoğu zaman ITRF96/TM'dir; gerçek dosya
  gelince `proj4` dönüşümü eklenmeli.
- **Harita sağlayıcısı** (`_components/PoleMap.tsx` seçici): Google anahtarı
  varsa bütün haritalar (Haritalar sayfası, bölge kartı, arıza mini haritası)
  **Google Maps** (`PoleMapGoogle.tsx`); kota dolunca / anahtar yokken / hata
  olunca **MapLibre + OpenStreetMap** (`PoleMapLibre.tsx`). İki uygulama aynı
  `PoleMapProps` sözleşmesini paylaşır.
  - **Kota koruması (para harcanmasın):** kesin sınır Google Cloud'daki
    "Map loads per day" kotasıdır. Uygulama onun altında kalan yumuşak sınırı
    uygular: istemci yeni Google haritası kurmadan önce `POST /api/map/session`
    sorar; `lib/mapUsage.ts` günlük (atomik) ve aylık sayaca bakar
    (`map_usage`, tüm müşteriler ortak), uygunsa artırıp `google`, değilse
    `osm` döner. DB hatası / anahtar yok → `osm`. Admin sayfasında sayaç kartı
    (`admin/MapUsage.tsx`, `GET /api/admin/map-usage`).
  - **Örnek havuzu** (`_lib/googleMap.ts`): Google her `new Map`'i faturalar.
    Haritalar ayrık `div`'lerde kurulur, sökülünce yok edilmez, havuza döner
    (`acquireGoogleMap(kind, scheme)` / `releaseGoogleMap`). Tür (`main` |
    `compact` | `preview`) ve tema başına havuz; sekme başına yükleme = aynı
    anda ekranda olan harita sayısı. Mini haritalar ekrana yaklaşınca alır,
    uzaklaşınca bırakır. **Google haritasını bileşen içinde `new
    google.maps.Map` ile kurmayın.**
  - **Tarayıcıda yalnızca Maps JavaScript API.** Places, Geocoding, Street
    View, Static Maps kullanılmaz (ayrı faturalanır); `clickableIcons: false`.
    Tek istisna **Routes API** (yol tarifi): yalnızca sunucudan, ayrı anahtarla
    ve kota sayacıyla (aşağıda).
  - **Yol tarifi** (direk paneli → "Yol tarifi", `_components/PoleRoute.tsx`):
    başlangıç = Konumum (GPS) · Haritada seç · başka direk · adres; Araç/Yaya.
    `POST /api/map/route { poleId, mode, origin: {kind:"point",lat,lng} |
    {kind:"pole",poleId} | {kind:"address",text} }` (`authorizePole` read,
    bütün roller; başlangıç direği aynı müşteriden). Sunucu
    `lib/googleRoutes.ts` → Compute Routes, **Essentials SKU'su**: alan maskesi
    + `TRAFFIC_UNAWARE` (trafik/rota değiştirici eklemeyin, Pro'ya çıkar);
    adresi Routes kendisi çözer (ayrı Geocoding yok). 10 dk bellek önbelleği,
    kullanıcı başına 10 dk'da 20 istek, sayaç `claimGoogleUsage("route")`
    (`map_usage.route_requests`, `GOOGLE_ROUTES_DAILY/MONTHLY_LIMIT`, boş =
    100 / 5000). Çizilemeyen durum hata değil `{ provider: "none", reason }`
    (unconfigured | quota | rate_limited | failed). **Google kuralı: rota
    yalnızca Google haritasında çizilir** (`PoleMapProps.route`, MapLibre yok
    sayar); harita OSM'deyken (`onProvider`) istek atılmaz. Her durumda
    ücretsiz "Navigasyonda aç / Google Haritalar'da aç" bağlantısı
    (`_lib/polyline.ts → googleMapsDirUrl`). Test: `npm run check:route`.
  - Çalışma anı hatası (`gm_authFailure`, hata kutusu) → o sekmede MapLibre.
  - Google 3B: binalar Google'dan, direkler `_lib/googlePoles3d.ts`
    (`WebGLOverlayView` + three.js, `InstancedMesh`; 3B ilk açılınca yüklenir).
- **Harita** (`_components/PoleMapLibre.tsx`, MapLibre GL, `ssr:false`): altlık
  `NEXT_PUBLIC_MAP_STYLE_URL[_DARK]`, yoksa anahtarsız OpenFreeMap
  (liberty/fiord, renkli; OSM atfı haritada). Kümeleme kaynakta, sorunlu direk içeren
  küme kırmızı. MapLibre oklch okumaz → renkler hex. `views/MapView.tsx`: durum
  filtreleri, yan panel (lambalar, arızalar, Aç/Kapat/Şiddet), "+ Direk ekle"
  (haritaya tık), "Konumu taşı" (sürükle + kaydet), konumsuz direği seçip
  yerleştirme. Bölge detayında `ZoneMapCard` + `PoleList`; süren arıza kartında
  mini harita (`FaultMiniMap`, `PoleMap preview`: etkileşimsiz, tıklayınca
  Harita sayfası; kart ekrana yaklaşınca kurulur — WebGL bağlam sınırı).
- **3 boyutlu görünüm** (Harita sayfası, sağ üstte Normal / 3 Boyutlu;
  `PoleMap view3d`; aşağıdaki ayrıntı MapLibre sürümüdür): eğik kamera, binalar ve direkler `fill-extrusion` ile
  (three.js yok). Direk geometrisi yakınlaşmaya göre ölçeklenir (`poleScale`,
  ekranda ~sabit boy), zoom 15'ten itibaren çizilir; armatür rengi direk
  durumundan. 3B'de "Kaydır / Döndür": Döndür'de sürükleme haritayı çevirir
  (`rotateDrag`). Binalar yalnızca stilde `openmaptiles` kaynağı varsa.

### Zamanlamalar

```
GET/POST         /api/schedules?customer=<slug>   # liste / oluştur (müşteri başına en fazla 100)
GET/PATCH/DELETE /api/schedules/:id                # PATCH: gelen alanlar satırla birleşip tam şemayla doğrulanır

Body (scheduleInputSchema):
{
  "name": "Akşam açılışı",                 # opsiyonel
  "action": "on" | "off" | "dim" | "efekt" | "stop_fx",
  "value": 0-100,                          # dim; on'da opsiyonel (o şiddette aç)
  "effectNumber": 1-28, "effectText": "…", # efekt (+ Mors)
  "target": { "all": true } | { "zones": [slug], "devices": [MAC], "lamps": [{ "mac", "channel" }] },
  "timeKind": "fixed" | "sunset" | "sunrise",
  "timeMinutes": 0-1439,                   # fixed
  "offsetMinutes": -180..180,              # sunset/sunrise
  "repeat": "once" | "weekly",
  "runDate": "YYYY-MM-DD",                 # once
  "weekdays": 1-127,                       # weekly, Pzt=1 … Paz=64
  "enabled": true
}
```

Guard: `authorizeScope` / `authorizeSchedule` (sahiplik DB satırından; başka
müşterinin zamanlaması → 404). Yazma admin + manager. Hedefteki bölge/MAC
müşteriye ait değilse, zaman geçmişteyse 422. Audit: `schedule.create` /
`schedule.update` / `schedule.delete` (çalıştırmalar audit'e yazılmaz;
`last_run_at` + `last_result` + `commands`).

### Cihaz Bakımı

```
POST /api/devices/:deviceId/maintenance   { "action": "commission" | "ota_check" }  → 202 { requestId }
```

Yalnızca tek cihaz. `ota_check` admin dışında 403. OTA koruması
(`lib/otaGuard.ts`, bellek içi, `/health`'ten beslenir): cihaz zaten
güncelleniyorsa ya da aynı bölgede başka bir cihaz güncelleniyor / son 3 dk
içinde OTA isteği aldıysa **409** (bölge eşlemesi: tenancy `deviceZone`).
Kayıt `commands` (`target_type:'device'`) + `audit_log` (`device.commission` /
`device.ota_check`).

### Raporlar

```
GET /api/reports?customer=<slug>&from=YYYY-MM-DD&to=YYYY-MM-DD[&zone=<slug>][&format=xlsx]
```

Dönemlik rapor, **en fazla 90 gün / 3 ay** (`REPORT_MAX_DAYS`, saklama süresiyle aynı), Türkiye takvim günleri
(bugünü kapsıyorsa bitiş "şimdi"). Tüm roller (izleyici dahil) görür ve indirir;
guard `authorizeScope(req, "read")`, başka müşterinin bölgesi 404, hatalı dönem 422.
`format=xlsx` → Excel (exceljs; sayfalar: Özet, Cihazlar, Arıza türleri, Arıza
kayıtları, Günlük, Bölgeler). Panel: `/c/<slug>/raporlar` (`views/ReportsView.tsx`).
Yeni tablo yok; `fault_events` + `d4i_telemetry` üzerinden hesaplanır.

- Kod: `lib/reports/range.ts` (saf; dönem + hazır seçenekler, istemci de kullanır),
  `build.ts` (saf hesap), `query.ts` (sorgular), `xlsx.ts`. Test: `npm run check:reports`.
- **Arıza** = armatür kaydı (`channel` dolu) ve `!isWarningCode`; **uyarı** ve
  **komut hatası** (`channel` NULL) ayrı sayılır, "en sık arıza"ya girmez.
  Sayı = dönemde **başlayan** kayıt; süre = kaydın dönemle kesişimi, cihazın
  arızalı kalma süresinde aynı anda süren kayıtlar bir kez sayılır (birleşim).
- **Enerji** = `energy_wh` birikimli sayacının armatür başına ardışık farkı (SQL
  `LAG`), sonraki okumanın gününe yazılır. Negatif fark (sayaç sıfırlandı) 0,
  `geçen saat × 1000 W` değerini aşan fark (sıçrama) sayılmaz. Dönem başı için
  2 gün geriye bakılır. Sayaç farkı olmayan cihazın enerjisi null ("Veri yok").
- **Yanma süresi** (yaklaşık): önceki okumada seviye > 0 ise aradaki süre, her
  aralık `freshMs` ile sınırlı; cihazda armatür başına ortalama.
- **Veri kapsaması:** cihazın ilk D4i raporundan (`loadFirstReports`) önceki
  günler sıfır değil "veri yok"tur (`ReportDay.covered`, `coverage`). Panel
  uyarı + grafikte gri bant gösterir, günlük ortalama yalnızca kayıtlı günlere
  bölünür; dönemde hiç ölçüm yoksa sayılar yerine "ölçüm kaydı yok" çıkar.
- Cihazlar **bugünkü** bölgelerinde raporlanır (taşınan cihazın geçmişi yeni
  bölgesine yazılır). `d4i_telemetry` 90 gün saklanır (`lib/retention.ts`);
  rapor dönemi (≤90 gün) tam olarak bu süreye eşittir.

### Cihaz kayıtları (yalnızca admin)

```
GET /api/admin/devices/:deviceId/records?kind=data|health|rf&limit=50&format=json|csv[&download=1]
```

Cihazın son N kaydı (varsayılan 50, en fazla 5000), yeniden eskiye. Guard
`authorizeAdmin`: müşteri kullanıcıları (manager/viewer) 403 alır.
- `data`: `d4i_telemetry` (lamba başına periyodik rapor, ham paket `raw`).
- `health`: `device_health_log` (her `/health` mesajı, **90 gün** saklanır).
- `rf`: aynı health satırlarının Thread radyo bloğu (`health.thread`: rol, parent
  RSSI/LQ, RLOC16, kanal, PAN, sayaçlar, `neighbors[]`).
- `format=csv` ya da `download=1` dosya olarak iner (`Content-Disposition`).
  CSV `lib/csv.ts` ile üretilir: `;` ayırıcı, ondalık virgül, UTF-8 BOM (Excel
  TR), iç içe alanlar noktalı sütun (`thread.channel`), diziler JSON hücre.

UI: cihaz modalinde **Kayıtlar** sekmesi (`_components/DeviceRecords.tsx`,
yalnızca `role === "admin"`): Veri · Health · RF alt görünümleri, satır açılınca
ham JSON / komşu listesi, CSV/JSON indirme. Müşteriye hiç gösterilmez.

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
  firmware_version VARCHAR(32), -- son /health mesajındaki sürüm
  health        JSONB,          -- son /health mesajı (ham; OTA durumu dahil)
  health_at     TIMESTAMPTZ,    -- son /health zamanı
  health_interval_s INTEGER,    -- firmware'in join'de bildirdiği aralıklar (sn);
  report_interval_s INTEGER,    --   NULL = bildirilmedi (0012_device_intervals)
  gateway_id    VARCHAR(100),   -- bağlı gateway (GW_ID, mantıksal ref; nodes / health'ten)
  master_on     BOOLEAN,        -- "Tüm cihaz" son komut snapshot'ı (0016_device_master);
  master_brightness INTEGER,    --   NULL = hiç komut almadı → panel bölge snapshot'ına düşer
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

> `master_*`: kanalsız cihaz komutu, alt grup, bölge ve "Tüm Sistem" komutları
> yazar (`recordCommand → patchDeviceMaster`); lamba (kanal) komutları ve
> telemetri değiştirmez. Cihaz modalinin "Tüm cihaz" açılış değeri buradan
> gelir (`GET /api/devices` → `masterOn`, `masterBrightness`).

> `health*` sütunları migration `0008_device_health.sql`. `/health` `devices`
> satırını günceller (son mesaj); ayrıca kayıtlı cihazın her mesajı
> `device_health_log`'a eklenir (admin "Kayıtlar", migration `0014`, 90 gün:
> `lib/retention.ts`, temizlik saatte en fazla bir kez health yazımının
> ardından, ayrı zamanlayıcı yok). `GET /api/devices` bunları
> `firmwareVersion`, `resetReason`, `ota`, `healthAt` olarak döner.

### `gateways`

```sql
CREATE TABLE gateways (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_id  VARCHAR(100) UNIQUE NOT NULL,  -- GW_ID = MAC (topic kimliği)
  customer_id UUID NOT NULL REFERENCES customers(id),
  zone_id     UUID REFERENCES zones(id) ON DELETE SET NULL,  -- opsiyonel konum etiketi
  type        VARCHAR(30) NOT NULL,          -- thread_br | cellular | wifi | lorawan
  name VARCHAR(100), location VARCHAR(200), notes TEXT,
  firmware_version VARCHAR(32),
  last_seen   TIMESTAMPTZ,
  online      BOOLEAN,                       -- false = LWT geldi
  health JSONB, health_at TIMESTAMPTZ,       -- son /health (ham)
  report JSONB, report_at TIMESTAMPTZ,       -- son /data (ham, türe özgü blok + nodes)
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

> Migration `0009_gateways.sql` (+ `devices.gateway_id`). Mesaj başına satır
> açılmaz. Çevrimiçi: LWT gelmediyse ve son 2 dk'da haber varsa
> (`gatewayState`).

### `poles`

```sql
CREATE TABLE poles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL,            -- belediye direk no; müşteri içinde benzersiz (uygulamada)
  name VARCHAR(100), notes TEXT,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,   -- WGS84; konumsuz direkte NULL
  location_source VARCHAR(10),          -- map | manual | gps | import
  location_accuracy_m REAL,             -- GPS doğruluğu
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_poles_zone_code ON poles(zone_id, code);
-- devices.pole_id UUID UNIQUE REFERENCES poles(id) ON DELETE SET NULL
```

> Migration `0011_poles.sql`. PostGIS yok: noktalar istemcide kümelenir;
> bbox sorgusu gerekirse Neon'da PostGIS açılabilir.

### `schedules`

```sql
CREATE TABLE schedules (
  id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers ON DELETE CASCADE,
  name VARCHAR(100), enabled BOOLEAN NOT NULL DEFAULT TRUE,
  action VARCHAR(20) NOT NULL,             -- on | off | dim | efekt | stop_fx
  value INTEGER, effect_number INTEGER, effect_text VARCHAR(32),
  target JSONB NOT NULL,                   -- planTargets çıktısı ya da {all:true}
  time_kind VARCHAR(10) NOT NULL,          -- fixed | sunset | sunrise
  time_minutes INTEGER, offset_minutes INTEGER NOT NULL DEFAULT 0,
  repeat VARCHAR(10) NOT NULL,             -- once | weekly
  run_date VARCHAR(10), weekdays INTEGER,  -- YYYY-MM-DD / bit maskesi
  next_run_at TIMESTAMPTZ,                 -- NULL = bitti / duraklatıldı
  last_run_at TIMESTAMPTZ, last_result JSONB,  -- {sent, skipped, missed?, error?}
  created_by UUID REFERENCES users ON DELETE SET NULL, created_at, updated_at
);
```

> Migration `0010_schedules.sql`. Ayrıca `map_usage(day PK 'YYYY-MM-DD' UTC,
> google_loads)` — Google harita yükleme sayacı (migration `0013_map_usage.sql`).
> Saf zaman/hesap testi: `npm run check:schedule`.

### `zone_groups`, `zone_group_members`, `device_zone_sync`

```sql
CREATE TABLE zone_groups (id UUID PK, zone_id UUID NOT NULL REFERENCES zones ON DELETE CASCADE,
  slug VARCHAR(32) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, created_at TIMESTAMPTZ);
CREATE TABLE zone_group_members (group_id UUID REFERENCES zone_groups ON DELETE CASCADE,
  device_id VARCHAR(100), PRIMARY KEY (group_id, device_id));
CREATE TABLE device_zone_sync (mac VARCHAR(100) PRIMARY KEY, reported TEXT[], reported_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'unknown',  -- unknown|pending|synced|error|unsupported|no_response
  last_error VARCHAR(200), last_error_at TIMESTAMPTZ, unsupported_fw VARCHAR(32), updated_at TIMESTAMPTZ);
```

> Migration `0015_zone_groups.sql`. `device_zone_sync` bilinçli olarak
> `devices`'a bağlı değil: silinen cihazın temizliği bu satırla yapılır.

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

> Cihaz kanal başına ~30 sn'de bir yayın yapar. **Saklama: 90 gün**
> (`lib/retention.ts → RECORD_RETENTION_DAYS`, `device_health_log` ile ortak):
> telemetri yazımının ardından saatte en fazla bir kez, 5000 satırlık
> parçalarla silinir; ayrı zamanlayıcı yok. 90 gündür rapor vermeyen armatürün
> panelde son ölçümü de "ölçüm gelmiyor" uyarısı da kalmaz.

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

# Harita altlığı (opsiyonel; boşsa anahtarsız OpenFreeMap liberty/fiord)
NEXT_PUBLIC_MAP_STYLE_URL=
NEXT_PUBLIC_MAP_STYLE_URL_DARK=

# Google Maps (opsiyonel; yalnızca Haritalar sayfası). Boşsa OpenStreetMap.
# Anahtar: HTTP referrer + yalnızca Maps JavaScript API. Map ID: Vector, Tilt + Rotation.
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=
# Uygulama içi kota (harita yüklemesi, tüm müşteriler ortak). Boş = 250 / 8000.
GOOGLE_MAPS_DAILY_LIMIT=
GOOGLE_MAPS_MONTHLY_LIMIT=
# Yol tarifi: SUNUCU anahtarı, yalnızca Routes API (NEXT_PUBLIC_ değil). Boşsa
# rota çizilmez, Google Haritalar bağlantısı verilir. Sınırlar boş = 100 / 5000.
GOOGLE_ROUTES_API_KEY=
GOOGLE_ROUTES_DAILY_LIMIT=
GOOGLE_ROUTES_MONTHLY_LIMIT=

# Binary uplink'in JSON aynası (opsiyonel, izleme): all | MAC1,MAC2 | boş=kapalı.
# Meven:<MAC>/json/data|health|reject topic'lerine basar.
MQTT_JSON_MIRROR=

# Dinamik bölge aboneliği: boş/on | observe (yalnızca zone_list) | off.
MQTT_ZONE_SYNC=
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
8. **Backend TEK instance çalışır.** (Zamanlayıcı da süreç içidir; çift çalıştırmayı DB claim'i önler, bkz. Zamanlamalar.) MQTT subscribe + SSE köprüsü in-memory event bus'a (`src/lib/events.ts`) dayanır; çoklu instance'ta status olayları farklı process'lere düşer ve canlı güncelleme bozulur. Yatay ölçekleme gerekince çözüm: Redis pub/sub (örn. Upstash).
9. **MQTT/env hatası web sunucusunu düşürmez.** `src/instrumentation.ts` MQTT başlatmayı try/catch ile sarar; broker erişilemese bile dashboard (DB okuması) çalışır.
10. **Publish önce, DB sonra.** Komut yolunda `publishCommand` (senkron, DB'ye dokunmaz) isteği alır almaz MQTT'ye yazar; `commands` INSERT'i, zone snapshot'ı ve SSE `recordCommand`'a taşınıp route'larda `after()` ile arka plana alınır. Sebep: publish DB'nin arkasındayken Neon round-trip'i (+ scale-to-zero uyanması) komutu saniyelerce geciktiriyordu. **Komut yoluna asla `await db...` eklemeyin** — snapshot/log işleri `recordCommand`'a girer. Ödün: zone/device bulunamasa da 202 döner (var olmayan topic'e publish zararsız, `recordCommand` warn'lar). Yetki kontrolü de DB'ye gitmez: tenancy index'i + JWT (`lib/auth/guard.ts`).
11. **Her `/api/*` route'u guard ile başlar** (`authorize*`, `lib/auth/guard.ts`); yalnızca `/api/auth/login`, `/api/auth/logout`, `/api/auth/token` ve `/api/auth/refresh` hariç. `src/proxy.ts` iyimser kontroldür, tek başına güvenlik sınırı değildir. Yeni route eklerken guard'ı unutma.
12. **Her sorgu müşteriye göre süzülür.** Liste sorguları `zones.customer_id` (ya da `tenancy` → `customer.macs`) ile kapsamlanır; kayıtsız MAC'lerin telemetrisi hiçbir müşteriye görünmez. Canlı olaylar `customerId` ile etiketlenir, SSE route'u buna göre süzer.
13. **`Meven:all/cmd` yalnızca admin'in global komutudur.** Müşteri "Tüm Sistem"i bölge topic'lerine fanout'tur.
14. **Bölge slug'ı rezerv listesine takılmaz ve asla yeniden kullanılmaz** (`isReservedZoneSlug`, `retired_zone_slugs`, `lib/zoneSlug.ts → allocateZoneSlug`).
15. **Sahiplik değiştiren her CRUD `refreshTenancy()`'yi yanıt dönmeden bekler** (bölge/cihaz/müşteri/kullanıcı). Aksi halde sonraki istek eski sahipliği görür.
16. **Mobil uygulamada kontrat kopyaları var.** Flutter uygulaması şu dosyaların Dart karşılıklarını taşır: `lib/effects.ts`, `lib/deviceErrors.ts`, `lib/faults.ts`, `lib/d4i.ts`, `app/_lib/deviceHealth.ts` (`isOnline` → `DeviceView.onlineWindowMs ?? 3 dk`), `app/_lib/alerts.ts`, `lib/auth/roles.ts`, `app/_lib/selection.ts` (toplu kontrol), `app/_lib/poles.ts` (`poleState`, `parseCoordinatePair`, `inTurkey`). Mobil zamanlama ekranı yapılırsa `lib/scheduleTime.ts` + `lib/sun.ts` de kopyalanır (önizleme; asıl hesap sunucuda). Bunlardan biri değişirse mobildeki `lib/contracts/` karşılığı da güncellenmeli. API yanıt şekli değişikliği de mobili kırar. Mobil müşteriye yönelik olduğu için katalogların **sade** metinlerini (`plain`, `plainLabel`) kullanmalı. Gateway alanları (`GatewayView.fields`, `typeLabel`) sunucuda role göre hazırlandığı için `lib/gateways.ts`'in kopyası gerekmez; mobil gateway durumunu gösterecekse yalnızca `gatewayState` (`GatewayView.onlineWindowMs ?? 2 dk` + LWT) kopyalanmalı.
17. **OTA (`ota_check`) asla toplu gönderilmez.** Aynı anda indiren cihazlar Thread ağını tıkıyor ve indirmeler yarıda kalıyor (firmware ekibinin saha notu). Bakım komutları yalnızca `Meven:<MAC>/cmd`'ye gider; aynı bölgede art arda OTA `lib/otaGuard.ts` ile 409'a takılır. Toplu güncelleme gerekiyorsa cihaz cihaz, arada birkaç dakika.
18. **Gateway mesajı paket sürüm baytıyla ayrılır.** Ağ geçitleri yalnızca binary basar, ilk bayt 0x03 (lamba 0x01). `decodeBinUplink` 0x03'ü `handleBrUplink`'e verir; kayıtlı gateway kimliğinden gelen 0x01 paketi atılır (cihaz yoluna girmez). Gateway'e lamba / zone komutu gitmez; yalnızca `report_now` ve `ota_check` (`publishGatewayCommand`).
19. **Binary alan tablosu OTA'dan önce güncellenir.** `src/lib/binproto/fields.ts` (lamba, 0x01) ve `brFields.ts` (Border Router, 0x03) firmware'in `msg_fields.h` kopyalarıdır; iki tablo ayrıdır (aynı kod farklı anlam taşıyabilir); tanımsız alanlı paket atılır (cihaz panelde görünmez). Mevcut bir alanın kodu/boyu/anlamı değişmez. Bkz. "Binary protokol v1".
20. **Cihazın dinlediği bölge topic'leri panelden yönetilir (yeni firmware).** Zone komutları yalnızca binary ve yalnızca `Meven:<MAC>/cmd`'ye gider; backend istenen durumu (bölge + alt gruplar) tutar, cihazı ona getirir (`lib/zoneSync`). Bölge/alt grup/cihaz silmek yalnızca DB işi değildir: üyelere `zone_remove`/`zone_clear` gider. Grup komutu yalnızca bütün üyeler senkronsa tek publish'tir; değilse üyelere cihaz komutu.
21. **Yalnızca binary protokol.** Cihazdan JSON kabul edilmez, cihaza JSON gönderilmez (komut, bakım, zone, gateway hepsi binary). `/data` ve `/health` aboneliği yalnızca eski firmware'i saymak içindir (`GET /api/admin/binproto`); oraya gelen mesaj işlenmez. JSON yolu geri eklenmez; binary'de karşılığı olmayan bir ihtiyaç çıkarsa önce firmware ekibiyle alan tablosu (`fields.ts`) genişletilir.

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
│   │   ├── binproto/                     # binary protokol v1: fields (alan tablosu), codec, toJson, command, shortIds (saf)
│   │   ├── zoneSync/                     # dinamik bölge aboneliği: plan.ts (saf), engine.ts (sunucu)
│   │   ├── zoneGroups.ts                 # alt grup listesi (sunucu)
│   │   ├── binUplink.ts                  # /bin alımı: sayaçlar, alarm, health önbelleği, binSeen, JSON reddi
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
