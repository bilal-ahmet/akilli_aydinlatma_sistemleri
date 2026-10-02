# Yapılabilir Geliştirmeler

Henüz uygulanmamış, değerlendirilmeyi bekleyen geliştirme fikirleri. Bir fikir
uygulanınca buradan çıkarılır.

---

## Telemetri / Ölçümler sekmesinde lamba kartlarını anlaşılır yapmak

**Ekran:** Cihaz paneli → Telemetri (müşteride "Ölçümler") sekmesi
(`src/app/_components/D4iPanel.tsx`).

### Sorun

Bir cihaza bağlı her lamba için ayrı bir kart var. Örnek: "Meven" cihazında
"DİREK ÜSTÜ LED" (ch0) ve "ARMATÜR" (ch1) adlı iki lamba. Her kartın içinde de
"Sürücü" ve "LED" kutuları var. Ekrana bakan kişi bunları aynı şeyin bölümleri
sanıyor. Üç sebebi var:

1. **Lamba adı bölüm başlığı gibi duruyor.** Ad Kontrol sekmesinde elle veriliyor
   (çoğu zaman büyük harfle) ve kartın bir lamba olduğunu gösteren hiçbir işaret
   yok. "Armatür" gibi bir ad, parça adıyla da karışıyor.
2. **Boş kutular gösteriliyor.** Ayrıntılı ölçüm (D4i) göndermeyen lambada
   "Sürücü" ve "LED" kutuları içi boş halde duruyor. Sağ üstte "D4i
   desteklemiyor" yazsa da kart üç bölümlü bir yapı gibi görünüyor.
3. **Başlıklar açıklamasız.** Üstteki kutuların başlığı yok. "Sürücü" ve "LED"
   kutularının lambanın içindeki iki ayrı parça olduğu yazmıyor. "Çalışma
   süresi" iki kez geçiyor, sıcaklık iki ayrı yerde çıkıyor ama neden iki tane
   olduğu belli değil.

Sahadaki yapı: direğin tepesinde bir **armatür** (lamba gövdesi) var. İçinde iki
parça bulunuyor:
- **sürücü:** şebeke elektriğini LED'e uygun hale getiren elektronik kart;
- **LED modülü:** ışığı üreten parça.

Telemetrideki her kart bir armatürü (lambayı) gösterir.

### Öneri

- **Kart başlığı lamba olduğunu göstersin:** ampul ikonu ve
  "Lamba · DİREK ÜSTÜ LED". Admin `ch0` bilgisini görmeye devam eder.
- **Ölçüm göndermeyen lambada boş kutular hiç gösterilmesin.** Yerine tek satır:
  "Bu lamba ayrıntılı ölçüm göndermiyor; yalnızca ışık seviyesi izlenebilir."
- **Üstteki özet kutularına "Lamba geneli" başlığı eklensin.**
- **Parça başlıkları açıklamalı olsun:**
  - "Sürücü (güç ünitesi) — şebeke elektriğini LED'e uygun hale getiren kart"
  - "LED modülü — ışığı üreten parça"
- **Aynı adlı ölçüler ayrışsın:** "Sürücü sıcaklığı" ile "LED sıcaklığı",
  "Sürücü çalışma süresi" ile "LED çalışma süresi". Müşteride "Sürücü" yerine
  "Güç ünitesi" yazılır.

Admin ve müşteri görünümünün ikisine de uygulanır. Müşteride parça kutuları
yine kapalı "Ayrıntılar" bölümünde kalır.
