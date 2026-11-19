/**
 * Gateway (ağ geçidi) kataloğu — SAF modül, istemci de kullanır.
 *
 * Ağ geçitleri lambalarla aynı topic şemasını kullanır (`Meven:<GW_ID>/…`) ama
 * verilerini YALNIZCA binary basar: `Meven:<GW_ID>/bin`, paketin ilk baytı
 * 0x03 (Thread Border Router; alan tablosu lib/binproto/brFields.ts). Lamba
 * paketleri 0x01'dir — ayrım sürüm baytıyla yapılır (Kural #18). Bağlantı
 * durumu `Meven:<GW_ID>/lwt` (retained `{"online":…}`), komutlar
 * `Meven:<GW_ID>/cmd`. Kontrat: firmware/GATEWAY-ENTEGRASYON.md.
 *
 * Saklanan health (lib/binproto/brToJson → brHealthJson): ortak zarf (`fw`,
 * `uptime_s`, `uplink`) + türe özgü blok (`thread`) + sistem/sayaç/OTA
 * blokları. Panelde gösterilecek alanlar burada, role göre (teknik/sade)
 * `summarizeGateway` ile sunucuda hazırlanır. Tanınmayan blok alanları
 * yutulmaz, admin'e ham haliyle gösterilir (deviceErrors.ts ilkesi).
 */

export const GATEWAY_TYPES = ["thread_br", "cellular", "wifi", "lorawan"] as const;
export type GatewayType = (typeof GATEWAY_TYPES)[number];

export function isGatewayType(v: unknown): v is GatewayType {
  return typeof v === "string" && (GATEWAY_TYPES as readonly string[]).includes(v);
}

/**
 * Bildirilmiş aralığı olmayan gateway'in "çalışıyor" penceresi. LWT
 * (`online:false`) geldiyse pencere beklenmez.
 */
export const GATEWAY_ONLINE_WINDOW_MS = 2 * 60_000;

/**
 * Gateway'in çevrimiçi penceresi: `max(2 dk, 2,5 × health aralığı)` —
 * lib/deviceWindows.ts'teki cihaz kuralıyla aynı. Border Router health'i
 * 300 sn'de bir gönderir (aralığı bağlantı başına bir kez, `health_interval_s`);
 * sabit 2 dk her gateway'i "Bağlantı yok" gösterirdi.
 */
export function gatewayOnlineWindowMs(health: Record<string, unknown> | null | undefined): number {
  const s = health?.health_interval_s;
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return GATEWAY_ONLINE_WINDOW_MS;
  return Math.max(GATEWAY_ONLINE_WINDOW_MS, Math.round(2.5 * s * 1000));
}

type FieldFormat = "text" | "int" | "dbm" | "duration" | "pct" | "bool" | "hex16";

interface FieldDef {
  key: string;
  label: string;
  /** Müşteriye gösterilecekse sade etiket; yoksa alan yalnızca admin'e görünür. */
  plainLabel?: string;
  format?: FieldFormat;
  /** Değer çevirisi (örn. Thread rolü) — admin. */
  values?: Record<string, string>;
  /** Müşteriye değer çevirisi; yoksa `values`. */
  plainValues?: Record<string, string>;
}

interface TypeInfo {
  label: string;
  plainLabel: string;
  /** Türe özgü bloğun health'teki anahtarı. */
  block: string;
  fields: FieldDef[];
}

export const GATEWAY_TYPE_INFO: Record<GatewayType, TypeInfo> = {
  thread_br: {
    label: "Thread Border Router",
    plainLabel: "Armatür ağı geçidi (Thread)",
    block: "thread",
    fields: [
      {
        key: "role",
        label: "Thread rolü",
        plainLabel: "Armatür ağı",
        values: {
          leader: "Leader",
          router: "Router",
          child: "Child",
          detached: "Detached (ağdan kopuk)",
          disabled: "Disabled",
        },
        plainValues: {
          leader: "Çalışıyor",
          router: "Çalışıyor",
          child: "Çalışıyor",
          detached: "Bağlantı kopuk",
          disabled: "Kapalı",
        },
      },
      { key: "network_name", label: "Ağ adı" },
      { key: "channel", label: "Kanal", format: "int" },
      { key: "pan_id", label: "PAN ID" },
      { key: "partition_id", label: "Partition ID" },
      { key: "rloc16", label: "RLOC16", format: "hex16" },
      { key: "leader_router_id", label: "Leader router ID", format: "int" },
      { key: "router_count", label: "Router sayısı", format: "int" },
      { key: "child_count", label: "Child sayısı", format: "int" },
      { key: "neighbor_count", label: "Komşu sayısı", format: "int" },
      {
        key: "border_routing_state",
        label: "Border routing",
        values: {
          running: "Çalışıyor",
          stopped: "Durdu",
          disabled: "Kapalı",
          uninitialized: "Başlatılmadı",
        },
      },
      { key: "border_agent_active", label: "Border agent", format: "bool" },
      { key: "cca_failure_pct", label: "Kanal meşguliyeti (CCA)", format: "pct" },
      { key: "detached_count", label: "Ağdan kopma", format: "int" },
      { key: "leader_count", label: "Leader olma", format: "int" },
      { key: "partition_id_changes", label: "Partition değişimi", format: "int" },
      { key: "attach_attempts", label: "Bağlanma denemesi", format: "int" },
      { key: "netdata_version", label: "Netdata sürümü", format: "int" },
      { key: "stable_netdata_version", label: "Kararlı netdata sürümü", format: "int" },
    ],
  },
  cellular: {
    label: "4G router",
    plainLabel: "Mobil hat (4G) geçidi",
    block: "cellular",
    fields: [
      { key: "operator", label: "Operatör", plainLabel: "Operatör" },
      { key: "network", label: "Şebeke tipi" },
      { key: "rssi", label: "RSSI", plainLabel: "Sinyal gücü", format: "dbm" },
      { key: "rsrp", label: "RSRP", format: "dbm" },
      { key: "iccid", label: "SIM ICCID" },
    ],
  },
  wifi: {
    label: "WiFi router",
    plainLabel: "WiFi geçidi",
    block: "wifi",
    fields: [
      { key: "ssid", label: "SSID", plainLabel: "Ağ adı" },
      { key: "rssi", label: "RSSI", plainLabel: "Sinyal gücü", format: "dbm" },
      { key: "clients", label: "Bağlı istemci", format: "int" },
    ],
  },
  lorawan: {
    label: "LoRaWAN gateway",
    plainLabel: "Uzun menzilli ağ geçidi (LoRaWAN)",
    block: "lorawan",
    fields: [
      { key: "gateway_eui", label: "Gateway EUI" },
      { key: "frequency_plan", label: "Frekans planı" },
      { key: "rx_packets", label: "Alınan paket", format: "int" },
      { key: "tx_packets", label: "Gönderilen paket", format: "int" },
    ],
  },
};

/** Tür etiketi; tanınmayan tür admin'e ham haliyle, müşteriye "Ağ geçidi" olarak. */
export function gatewayTypeLabel(type: string, technical: boolean): string {
  if (!isGatewayType(type)) return technical ? type : "Ağ geçidi";
  const info = GATEWAY_TYPE_INFO[type];
  return technical ? info.label : info.plainLabel;
}

const UPLINK_KINDS: Record<string, string> = {
  ethernet: "Kablolu (Ethernet)",
  wifi: "WiFi",
  cellular: "Mobil hat (4G)",
};

const RESET_REASON_LABELS: Record<string, string> = {
  power_on: "Güç verildi",
  software: "Yazılım (yeniden başlatma)",
  panic: "Çökme (panic)",
  int_wdt: "Watchdog (kesme)",
  task_wdt: "Watchdog (görev)",
  wdt: "Watchdog",
  brownout: "Düşük gerilim (brownout)",
  external_pin: "Reset pini",
  deep_sleep: "Derin uyku",
};

const OTA_STATE_LABELS: Record<string, string> = {
  idle: "Boşta",
  waiting_network: "Ağ bekleniyor",
  checking: "Kontrol ediliyor",
  downloading: "İndiriliyor",
  verifying: "Doğrulanıyor",
  updated: "Güncellendi",
  failed: "Başarısız",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "3 gün 4 sa", "5 sa 12 dk", "42 dk", "30 sn". */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} gün ${h} sa`;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk`;
  return `${s} sn`;
}

const intFmt = (v: number) => new Intl.NumberFormat("tr-TR").format(v);

function formatValue(v: unknown, def?: FieldDef, technical = true): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    const values = !technical && def?.plainValues ? def.plainValues : def?.values;
    return values?.[v] ?? v;
  }
  if (typeof v === "number") {
    switch (def?.format) {
      case "dbm":
        return `${v} dBm`;
      case "duration":
        return formatUptime(v);
      case "pct":
        return `%${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(v)}`;
      case "hex16":
        return `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;
      default:
        return intFmt(v);
    }
  }
  if (typeof v === "boolean") return v ? (def?.format === "bool" ? "Etkin" : "Evet") : def?.format === "bool" ? "Kapalı" : "Hayır";
  return JSON.stringify(v);
}

function kib(bytes: number): string {
  return `${intFmt(Math.round(bytes / 1024))} KB`;
}

export interface GatewayField {
  label: string;
  value: string;
}

/**
 * Panelde gösterilecek alanlar: önce ortak zarf (yazılım sürümü, çalışma
 * süresi, internet bağlantısı), sonra türe özgü blok, admin'e ek olarak
 * sistem, ağ sayaçları ve OTA.
 *
 * Admin: tanımlı tüm alanlar + bloktaki tanınmayan alanlar (ham).
 * Müşteri: yalnızca `plainLabel`'ı olan alanlar, sade değerlerle.
 */
export function summarizeGateway(
  g: {
    type: string;
    health: Record<string, unknown> | null;
  },
  opts: { technical: boolean },
): GatewayField[] {
  const { technical } = opts;
  const h = g.health ?? {};
  const out: GatewayField[] = [];
  const push = (label: string, value: string | null) => {
    if (value !== null) out.push({ label, value });
  };

  if (technical) push("Firmware", formatValue(h.fw));
  const uptime = num(h.uptime_s);
  if (uptime !== null) push("Çalışma süresi", formatUptime(uptime));

  const uplink = asRecord(h.uplink);
  if (uplink) {
    const kind = typeof uplink.kind === "string" ? (UPLINK_KINDS[uplink.kind] ?? uplink.kind) : null;
    if (kind) push("İnternet bağlantısı", uplink.connected === false ? `${kind} (bağlantı yok)` : kind);
    const rssi = num(uplink.rssi);
    if (rssi !== null) push(technical ? "Uplink RSSI" : "Sinyal gücü", `${rssi} dBm`);
    if (technical) {
      const ch = num(uplink.channel);
      if (ch !== null) push("WiFi kanalı", String(ch));
      const disc = num(uplink.disconnects);
      if (disc !== null) push("WiFi kopma (açılıştan beri)", intFmt(disc));
      const reason = num(uplink.last_disconnect_reason);
      if (reason !== null) push("Son kopma nedeni", `wifi_err_reason ${reason}`);
    }
  }

  const info = isGatewayType(g.type) ? GATEWAY_TYPE_INFO[g.type] : null;
  const block = info ? asRecord(h[info.block]) : null;
  if (info && block) {
    const known = new Set<string>();
    for (const def of info.fields) {
      known.add(def.key);
      if (!technical && !def.plainLabel) continue;
      push(technical ? def.label : def.plainLabel!, formatValue(block[def.key], def, technical));
    }
    if (technical) {
      for (const [key, v] of Object.entries(block)) {
        if (!known.has(key)) push(key, formatValue(v));
      }
    }
  }

  if (!technical) return out;

  // Sistem
  const heap = num(h.free_heap_bytes);
  const minHeap = num(h.min_free_heap_bytes);
  if (heap !== null) push("Boş bellek", minHeap !== null ? `${kib(heap)} (en düşük ${kib(minHeap)})` : kib(heap));
  if (typeof h.reset_reason === "string") push("Son açılış nedeni", RESET_REASON_LABELS[h.reset_reason] ?? h.reset_reason);
  const connects = num(h.mqtt_connects);
  if (connects !== null) push("MQTT bağlantı sayısı", intFmt(connects));
  const pubFails = num(h.mqtt_publish_fails);
  if (pubFails) push("MQTT gönderim hatası", intFmt(pubFails));
  if (typeof h.idf_version === "string") push("ESP-IDF", h.idf_version);
  if (typeof h.build_date === "string") push("Derleme", `${h.build_date} ${h.build_time ?? ""}`.trim());
  const hi = num(h.health_interval_s);
  const ti = num(h.topology_interval_s);
  if (hi !== null || ti !== null) {
    push(
      "Rapor aralığı",
      [hi !== null ? `durum ${formatUptime(hi)}` : null, ti !== null ? `topoloji ${formatUptime(ti)}` : null]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // Thread MAC sayaçları (son health'ten bu yana fark)
  const c = asRecord(h.counters);
  if (c) {
    const period = num(c.period_s);
    const suffix = period ? ` (son ${formatUptime(period)})` : "";
    const req = num(c.mac_tx_ack_requested);
    const acked = num(c.mac_tx_acked);
    if (req && acked !== null) push(`MAC TX başarısı${suffix}`, formatValue((acked / req) * 100, { key: "", label: "", format: "pct" })!);
    const retry = num(c.mac_tx_retry);
    if (retry !== null) push(`MAC yeniden deneme${suffix}`, intFmt(retry));
    const cca = num(c.mac_tx_err_cca);
    if (cca) push(`CCA hatası${suffix}`, intFmt(cca));
    const fcs = num(c.mac_rx_err_fcs);
    if (fcs) push(`RX FCS hatası${suffix}`, intFmt(fcs));
    const ipFail = num(c.ip_tx_failure);
    const ipOk = num(c.ip_tx_success);
    if (ipOk !== null || ipFail !== null) push(`IP TX başarılı / hatalı${suffix}`, `${intFmt(ipOk ?? 0)} / ${intFmt(ipFail ?? 0)}`);
  }

  // OTA
  const ota = asRecord(h.ota);
  if (ota) {
    const state = typeof ota.state === "string" ? (OTA_STATE_LABELS[ota.state] ?? ota.state) : null;
    const err = typeof ota.last_error === "string" ? ota.last_error : null;
    if (state) push("OTA", err ? `${state} · ${err}` : state);
    if (typeof ota.last_target_version === "string" && ota.last_target_version) {
      push("OTA hedef sürüm", ota.last_target_version);
    }
  }
  return out;
}

// ── Komutlar (report_now / ota_check) ────────────────────────

export const GATEWAY_COMMAND_LABELS: Record<string, { technical: string; plain: string }> = {
  report_now: { technical: "Şimdi raporla (report_now)", plain: "Şimdi raporla" },
  ota_check: { technical: "Güncelleme kontrolü (ota_check)", plain: "Güncelleme kontrolü" },
};

/** Sonuç kodu → müşteriye gösterilecek metin (admin ham metni + kodu görür). */
const COMMAND_RESULT_PLAIN: Record<number, string> = {
  [-2]: "Ağ geçidi bu komutu desteklemiyor",
  [-5]: "Ağ geçidi bu komutu desteklemiyor",
  [-12]: "Güncelleme servisi henüz hazır değil",
  [-15]: "Komut ağ geçidine bozuk ulaştı",
  [-16]: "Ağ geçidi bu komut sürümünü desteklemiyor",
  [-17]: "Komut ağ geçidine bozuk ulaştı",
};

export function gatewayCommandErrorText(
  result: number,
  raw: string | null,
  technical: boolean,
): string {
  if (technical) return `${raw ?? "hata"} (${result})`;
  return COMMAND_RESULT_PLAIN[result] ?? "Ağ geçidi komutu işleyemedi";
}

// ── Durum ────────────────────────────────────────────────────

export type GatewayState = "online" | "offline" | "never";

/**
 * Durum: hiç rapor yok → "never"; LWT geldi ya da pencere doldu → "offline".
 * Pencere `onlineWindowMs` (gateway'in bildirdiği health aralığından,
 * gatewayOnlineWindowMs), yoksa 2 dk. `now` null (ilk render, saat henüz yok)
 * iken null döner — yargıya varılmaz.
 */
export function gatewayState(
  g: { lastSeen: string | null; online: boolean | null; onlineWindowMs?: number | null },
  now: number | null,
): GatewayState | null {
  if (!g.lastSeen) return "never";
  if (g.online === false) return "offline";
  if (now === null) return null;
  const windowMs = g.onlineWindowMs ?? GATEWAY_ONLINE_WINDOW_MS;
  return now - new Date(g.lastSeen).getTime() < windowMs ? "online" : "offline";
}
