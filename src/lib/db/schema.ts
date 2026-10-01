import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  bigserial,
  doublePrecision,
  jsonb,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Şema, CLAUDE.md'deki SQL tablolarını temel alır. İki pragmatik uzantı var
 * (yorumlarda işaretli): `zones`'a public `slug` (MQTT topic / API id'si) ve
 * dashboard'un zone seviyesinde okuyabilmesi için snapshot alanları
 * (district, pole_count, is_on, brightness, status). Kural #6 — "dashboard
 * her zaman DB'den okur" — bu sayede zone granülaritesinde sağlanır.
 * Ham cihaz telemetrisi yine `device_status`'a akar.
 */

/**
 * Müşteri (kiracı). Her bölge tam olarak bir müşteriye aittir; cihazın
 * müşterisi bölgesinden türetilir (tek doğruluk kaynağı). Pasif müşterinin
 * kullanıcıları giriş yapamaz, cihazları ise çalışmaya devam eder.
 */
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 100 }).notNull().unique(), // URL: /c/<slug>
  name: varchar("name", { length: 150 }).notNull(),
  contactName: varchar("contact_name", { length: 150 }),
  contactEmail: varchar("contact_email", { length: 150 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/**
 * Panel kullanıcıları. `admin` platformun tamamını yönetir (customer_id NULL);
 * `manager` kendi müşterisinde tam yetkili, `viewer` salt okunur.
 * `token_version` şifre değişiminde/pasifleştirmede artar → eski oturumlar düşer.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: varchar("username", { length: 64 }).notNull().unique(), // küçük harf
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 150 }),
    role: varchar("role", { length: 20 }).notNull(), // admin | manager | viewer
    customerId: uuid("customer_id").references(() => customers.id),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    tokenVersion: integer("token_version").notNull().default(0),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_users_customer_id").on(t.customerId),
    check(
      "chk_users_role_customer",
      sql`(${t.role} = 'admin' AND ${t.customerId} IS NULL) OR (${t.role} IN ('manager','viewer') AND ${t.customerId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Mobil cihaz oturumları — bir satır = bir cihazdaki giriş. Refresh token
 * opak rastgele bir değerdir; yalnızca sha256 özeti saklanır. Her refresh'te
 * döner (rotasyon): yeni özet `refresh_hash`'e, eskisi `prev_refresh_hash`'e
 * geçer. Eski token kısa tolerans penceresi dışında tekrar gelirse token
 * çalınmış sayılır ve oturum iptal edilir (bkz. lib/auth/mobileSession.ts).
 *
 * `token_version` oturum açıldığındaki kullanıcı sürümüdür; şifre değişimi
 * ya da sıfırlama `users.token_version`'ı artırınca refresh reddedilir.
 * İleride push bildirimi için cihaz token'ı da bu satıra bağlanır.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshHash: varchar("refresh_hash", { length: 64 }).notNull().unique(),
    prevRefreshHash: varchar("prev_refresh_hash", { length: 64 }),
    tokenVersion: integer("token_version").notNull(),
    deviceName: varchar("device_name", { length: 100 }),
    platform: varchar("platform", { length: 20 }), // android | ios
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Son rotasyon anı — eski token'ın tolerans penceresi buna göre hesaplanır. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_auth_sessions_user_id").on(t.userId),
    index("idx_auth_sessions_prev_hash").on(t.prevRefreshHash),
  ],
);

export const zones = pgTable("zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  // [uzantı] MQTT topic ve API route'larında kullanılan stabil public id.
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  // Sahip müşteri. Bölgenin cihazları da bu müşteriye aittir.
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  // [uzantı] dashboard snapshot alanları
  district: varchar("district", { length: 100 }),
  poleCount: integer("pole_count").notNull().default(0),
  isOn: boolean("is_on").notNull().default(false),
  brightness: integer("brightness").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("ok"), // ok | warning | fault
  activeFx: integer("active_fx"), // aktif efekt numarası (1-14, null = yok)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("idx_zones_customer_id").on(t.customerId)]);

/**
 * Silinmiş bölgelerin slug'ları. Slug = MQTT topic (`Meven:<slug>/cmd`) ve
 * sahada o slug ile flaşlanmış cihazlar bölge silindikten sonra da o topic'i
 * dinlemeye devam eder. Slug başka bir müşteriye verilirse o müşterinin bölge
 * komutları eski cihazlara ulaşır — bu yüzden silinen slug bir daha verilmez.
 */
export const retiredZoneSlugs = pgTable("retired_zone_slugs", {
  slug: varchar("slug", { length: 100 }).primaryKey(),
  customerId: uuid("customer_id"),
  retiredAt: timestamp("retired_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Denetim kaydı: kim, hangi müşteri adına, ne yaptı. Admin müşteri panelinde
 * işlem yaptığında `customer_id` o müşteridir, `user_id` admin'dir.
 * Komutlar burada değil `commands.user_id`'de izlenir (yüksek frekanslı).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id"),
    username: varchar("username", { length: 64 }),
    customerId: uuid("customer_id"),
    action: varchar("action", { length: 60 }).notNull(), // zone.create, auth.login_failed…
    target: varchar("target", { length: 150 }),
    detail: jsonb("detail"),
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [
    index("idx_audit_log_customer_at").on(t.customerId, t.at.desc()),
    index("idx_audit_log_at").on(t.at.desc()),
  ],
);

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 100 }).notNull().unique(), // ESP32 tanımlayıcısı
  zoneId: uuid("zone_id").references(() => zones.id),
  name: varchar("name", { length: 100 }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  // Cihazın son komut yanıtı hata ise metni burada durur (dashboard rozeti).
  // Sonraki `{"status":"ok"}` yanıtında temizlenir.
  lastError: varchar("last_error", { length: 200 }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/**
 * Bir ESP'ye (cihaza) bağlı tek bağımsız aydınlatma = "fixture" (DALI kanalı).
 * Bir cihazda birden çok lamba olabilir; her biri ayrı `channel` (0-63) ile
 * adreslenir ve bağımsız aç/kapa/dim/efekt ile sürülür. Cihaz raporundan
 * (Meven:<MAC>/data → channels[]) otomatik upsert edilir; dashboard'dan manuel
 * de eklenebilir. Kimlik deseni `device_status` ile aynı: deviceId = MAC.
 */
export const fixtures = pgTable(
  "fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: varchar("device_id", { length: 100 }).notNull(), // MAC
    channel: integer("channel").notNull(), // DALI kanal (lamba) no, 0-63
    name: varchar("name", { length: 100 }),
    brightness: integer("brightness").notNull().default(0),
    isOn: boolean("is_on").notNull().default(false),
    activeFx: integer("active_fx"), // aktif efekt numarası (1-14, null = yok)
    status: varchar("status", { length: 20 }).notNull().default("ok"), // ok | fault
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("uq_fixtures_device_channel").on(t.deviceId, t.channel),
    index("idx_fixtures_device_id").on(t.deviceId),
  ],
);

export const deviceStatus = pgTable(
  "device_status",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: varchar("device_id", { length: 100 }).notNull(), // MAC
    // Yeni veri payload alanları (Meven:<MAC>/data)
    brightness: integer("brightness"),
    relayStatus: varchar("relay_status", { length: 8 }), // on | off
    temperature: integer("temperature"),
    rssi: integer("rssi"),
    status: varchar("status", { length: 20 }), // ok | error
    // Eski alanlar (geri uyum; veri payload'ında artık yok)
    action: varchar("action", { length: 20 }),
    value: integer("value"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_device_status_device_id").on(t.deviceId),
    index("idx_device_status_recorded_at").on(t.recordedAt.desc()),
  ],
);

/**
 * D4i periyodik raporu (`{"type":"d4i_periodic", ...}`) — DALI adresi (lamba)
 * başına bir satır, append-only geçmiş. Sık okunan/grafiğe girecek büyüklükler
 * ayrı sütunda; sürücü ve LED'in tüm arıza sayaçları dahil ham `d4i` bloğu
 * `raw` içinde saklanır (kontrat büyüdükçe migration gerekmesin diye).
 *
 * Not: cihaz ~30 sn'de bir kanal başına yayın yapar; uzun vadede saklama
 * politikası (örn. 90 günden eskiyi sil) gerekecek.
 */
export const d4iTelemetry = pgTable(
  "d4i_telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: varchar("device_id", { length: 100 }).notNull(), // MAC (topic'ten)
    channel: integer("channel").notNull(), // payload'daki `address`
    online: boolean("online"),
    d4iSupported: boolean("d4i_supported").notNull().default(false),
    // DALI durum bloğu
    statusByte: integer("status_byte"),
    actualLevel: integer("actual_level"), // 0-254 arc level
    minLevel: integer("min_level"),
    maxLevel: integer("max_level"),
    physicalMinLevel: integer("physical_min_level"),
    lampFailure: boolean("lamp_failure"),
    lampPowerOn: boolean("lamp_power_on"),
    controlGearPresent: boolean("control_gear_present"),
    // D4i başlık metrikleri
    energyWh: doublePrecision("energy_wh"),
    powerW: doublePrecision("power_w"),
    driverTemperatureC: integer("driver_temperature_c"),
    driverVoltageV: integer("driver_voltage_v"),
    driverOperatingTimeS: integer("driver_operating_time_s"),
    ledTemperatureC: integer("led_temperature_c"),
    ledVoltageV: doublePrecision("led_voltage_v"),
    ledCurrentA: doublePrecision("led_current_a"),
    // Ham `d4i` bloğunun tamamı (sürücü/LED arıza sayaçları vb.)
    raw: jsonb("raw"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_d4i_telemetry_device_channel").on(t.deviceId, t.channel),
    index("idx_d4i_telemetry_recorded_at").on(t.recordedAt.desc()),
  ],
);

/**
 * Arıza geçmişi — bir arızanın BAŞLANGICI ve ÇÖZÜLDÜĞÜ an, epizot başına tek
 * satır. `d4i_telemetry` her raporu (kanal başına ~30 sn) sakladığı için arıza
 * geçmişi oradan türetilemez: 7 günlük geçmiş bile yüz binlerce satır tarar.
 * Bu tabloya yalnızca DURUM DEĞİŞİMİNDE yazılır (bkz. lib/faultLog.ts).
 *
 * `resolved_at IS NULL` → arıza hâlâ sürüyor. Kod kataloğu: lib/faults.ts.
 */
export const faultEvents = pgTable(
  "fault_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: varchar("device_id", { length: 100 }).notNull(), // MAC
    // DALI adresi (lamba). NULL = cihaz seviyesi arıza (komut hatası).
    channel: integer("channel"),
    code: varchar("code", { length: 60 }).notNull(), // "lamp_failure", "driver.thermal_shutdown", "command.channel-not-found"…
    detail: varchar("detail", { length: 300 }), // ham hata metni (komut hatası) vb.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_fault_events_device_started").on(t.deviceId, t.startedAt.desc()),
    // Açık arızaları çözmek için: her raporda (deviceId, channel, resolvedAt IS NULL) sorgulanır.
    index("idx_fault_events_open").on(t.deviceId, t.channel, t.resolvedAt),
  ],
);

export const commands = pgTable("commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().unique(), // idempotency
  targetType: varchar("target_type", { length: 20 }).notNull(), // zone | device | customer | all
  targetId: varchar("target_id", { length: 100 }).notNull(),
  // Komutu veren kullanıcı ve komutun verildiği müşteri ("all" için NULL).
  userId: uuid("user_id"),
  customerId: uuid("customer_id"),
  channel: integer("channel"), // hedef DALI kanal (lamba) no; null = tüm cihaz
  action: varchar("action", { length: 20 }).notNull(),
  value: integer("value"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | delivered | failed
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export type CustomerRow = typeof customers.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type ZoneRow = typeof zones.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type FixtureRow = typeof fixtures.$inferSelect;
export type DeviceStatusRow = typeof deviceStatus.$inferSelect;
export type D4iTelemetryRow = typeof d4iTelemetry.$inferSelect;
export type FaultEventRow = typeof faultEvents.$inferSelect;
export type CommandRow = typeof commands.$inferSelect;
