/**
 * Raporlar (`GET /api/reports`) — API, panel ve Excel çıktısının ortak tipleri.
 * Hesap kuralları: `lib/reports/build.ts` (saf), sorgular: `lib/reports/query.ts`.
 *
 * Tarihler ISO (UTC) metindir; gün anahtarları Türkiye takvim günüdür
 * (`YYYY-MM-DD`). Süreler milisaniye, enerji kWh.
 */

/** Arıza kaydının türü: armatür arızası, uyarı (ışık yanıyor ama kısılmış) ya da komut hatası. */
export type ReportFaultKind = "fault" | "warning" | "command";

export interface ReportPeriodInfo {
  /** İlk gün (dahil), YYYY-MM-DD. */
  from: string;
  /** Son gün (dahil), YYYY-MM-DD. */
  to: string;
  /** Takvim günü sayısı (1-90). */
  days: number;
  /** Dönemin başladığı an (ilk gün 00:00, Türkiye). */
  startAt: string;
  /** Dönemin bittiği an: son günün ertesi 00:00 ya da bugünü kapsıyorsa "şimdi". */
  endAt: string;
  /** Bitiş "şimdi"de kesildi mi (dönem bugünü kapsıyor). */
  partial: boolean;
}

export interface ReportTopFault {
  code: string;
  label: string;
  count: number;
}

export interface ReportTotals {
  /** Kapsamdaki (bugün kayıtlı) cihaz sayısı. */
  devices: number;
  /** Dönemde en az bir ölçüm gönderen cihaz. */
  measuredDevices: number;
  /** Toplam enerji; hiçbir cihazdan sayaç farkı alınamadıysa null. */
  energyKwh: number | null;
  /** Günlük ortalama enerji (dönemin ölçüm kaydı olan kısmına göre). */
  avgDailyKwh: number | null;
  /** Dönemde başlayan armatür arızası (uyarılar hariç). */
  faults: number;
  /** Dönemde başlayan uyarı. */
  warnings: number;
  /** Dönemde başlayan komut hatası. */
  commandErrors: number;
  /** Dönemin herhangi bir anında arızalı olan cihaz. */
  faultyDevices: number;
  /** Dönem sonunda hâlâ süren arıza. */
  openAtEnd: number;
  /** Cihazların arızalı kalma sürelerinin toplamı (cihaz başına birleşim). */
  faultDurationMs: number;
  /** En sık başlayan arıza (uyarılar hariç); dönemde arıza yoksa null. */
  topFault: ReportTopFault | null;
}

export interface ReportDay {
  /** YYYY-MM-DD (Türkiye). */
  date: string;
  /** O gün harcanan enerji; o gün hiç sayaç farkı yoksa null. */
  energyKwh: number | null;
  /** O gün başlayan armatür arızası. */
  faults: number;
  /** O gün başlayan uyarı. */
  warnings: number;
  /** Gün ölçüm kaydının kapsamında mı (kapsamdaki ilk ölçümden sonra). Değilse "veri yok". */
  covered: boolean;
}

/**
 * Veri kapsaması: ölçüm kaydı ne zaman başladı. Veri SİLİNMEZ ama sistem ya da
 * cihaz dönemin ortasında devreye girmiş olabilir; öncesi sıfır değil "veri yok".
 */
export interface ReportCoverage {
  /** Kapsamdaki cihazların en eski ölçümü (ISO); hiç ölçüm yoksa null. */
  dataFrom: string | null;
  /** Dönemin ölçüm kaydı öncesinde kalan gün sayısı (0 = dönemin tamamı kayıtlı). */
  uncoveredDays: number;
  /** Ölçümü dönem içinde başlayan cihaz (toplamları dönemin yalnızca bir kısmını kapsar). */
  partialDevices: number;
  /** Dönem sonuna kadar hiç ölçüm göndermemiş cihaz. */
  noDataDevices: number;
}

export interface ReportFaultType {
  code: string;
  label: string;
  /** Hangi parça: armatür, sürücü ünitesi, LED modülü, bağlantı, komut. */
  category: string;
  kind: ReportFaultKind;
  /** Dönemde başlayan kayıt sayısı. */
  count: number;
  /** Dönemde bu sorunu yaşayan farklı cihaz. */
  devices: number;
  /** Dönemde bu sorunu yaşayan farklı armatür (komut hatasında 0). */
  lamps: number;
  /** Dönemle kesişen sürelerin toplamı (kayıt başına). */
  durationMs: number;
  /** Dönem sonunda süren kayıt. */
  openAtEnd: number;
}

export interface ReportDevice {
  mac: string;
  /** Görünen ad (girilmiş isim; yoksa admin'e MAC, müşteriye "Cihaz …3456"). */
  name: string;
  zoneSlug: string;
  zoneName: string;
  faults: number;
  warnings: number;
  commandErrors: number;
  /** Cihazın en sık başlayan arızası. */
  topFault: ReportTopFault | null;
  /** Arızalı kalma süresi (aynı anda süren arızalar bir kez sayılır). */
  faultDurationMs: number;
  /** Dönem sonunda süren arıza. */
  openAtEnd: number;
  /** Dönemdeki enerji; sayaç farkı yoksa null. */
  energyKwh: number | null;
  /** Yaklaşık yanma süresi, armatür başına ortalama (saat). */
  burnHours: number | null;
  /** Dönemde ölçüm gönderen armatür sayısı. */
  lamps: number;
  /** Dönemde en az bir ölçüm geldi mi. */
  measured: boolean;
  /** Cihazın bilinen ilk ölçümü (ISO); hiç yoksa null. */
  dataFrom: string | null;
  /** Ölçümü dönem içinde başladı (dönemin başı için verisi yok). */
  partial: boolean;
}

export interface ReportZone {
  slug: string;
  name: string;
  devices: number;
  measuredDevices: number;
  faults: number;
  faultyDevices: number;
  openAtEnd: number;
  energyKwh: number | null;
}

export interface ReportData {
  period: ReportPeriodInfo;
  customer: { slug: string; name: string };
  /** Süzülen bölge; null = tüm bölgeler. */
  zone: { slug: string; name: string } | null;
  /** Metinler teknik dilde mi üretildi (admin). */
  technical: boolean;
  generatedAt: string;
  totals: ReportTotals;
  coverage: ReportCoverage;
  daily: ReportDay[];
  faultTypes: ReportFaultType[];
  devices: ReportDevice[];
  /** Bölge kırılımı — yalnızca tüm bölgeler seçiliyken dolu. */
  zones: ReportZone[];
}

/** Tek arıza kaydı — yalnızca Excel'in "Arıza kayıtları" sayfası için. */
export interface ReportEvent {
  startedAt: string;
  /** null = hâlâ sürüyor. */
  resolvedAt: string | null;
  mac: string;
  deviceName: string;
  zoneName: string;
  /** Armatür (DALI kanalı); komut hatasında null. */
  channel: number | null;
  code: string;
  label: string;
  category: string;
  kind: ReportFaultKind;
  /** Ham hata metni — yalnızca teknik dilde (admin). */
  detail: string | null;
  /** Kaydın tüm süresi (sürüyorsa "şimdi"ye kadar). */
  durationMs: number;
}
