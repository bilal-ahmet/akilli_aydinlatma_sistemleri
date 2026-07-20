import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  bigserial,
  index,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Şema, CLAUDE.md'deki SQL tablolarını temel alır. İki pragmatik uzantı var
 * (yorumlarda işaretli): `zones`'a public `slug` (MQTT topic / API id'si) ve
 * dashboard'un zone seviyesinde okuyabilmesi için snapshot alanları
 * (district, pole_count, is_on, brightness, status). Kural #6 — "dashboard
 * her zaman DB'den okur" — bu sayede zone granülaritesinde sağlanır.
 * Ham cihaz telemetrisi yine `device_status`'a akar.
 */

export const zones = pgTable("zones", {
  id: uuid("id").primaryKey().defaultRandom(),
  // [uzantı] MQTT topic ve API route'larında kullanılan stabil public id.
  slug: varchar("slug", { length: 100 }).notNull().unique(),
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
});

export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: varchar("device_id", { length: 100 }).notNull().unique(), // ESP32 tanımlayıcısı
  zoneId: uuid("zone_id").references(() => zones.id),
  name: varchar("name", { length: 100 }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
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

export const commands = pgTable("commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().unique(), // idempotency
  targetType: varchar("target_type", { length: 20 }).notNull(), // zone | device
  targetId: varchar("target_id", { length: 100 }).notNull(),
  channel: integer("channel"), // hedef DALI kanal (lamba) no; null = tüm cihaz
  action: varchar("action", { length: 20 }).notNull(),
  value: integer("value"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | delivered | failed
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export type ZoneRow = typeof zones.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type FixtureRow = typeof fixtures.$inferSelect;
export type DeviceStatusRow = typeof deviceStatus.$inferSelect;
export type CommandRow = typeof commands.$inferSelect;
