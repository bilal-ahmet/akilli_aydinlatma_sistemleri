CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"username" varchar(64),
	"customer_id" uuid,
	"action" varchar(60) NOT NULL,
	"target" varchar(150),
	"detail" jsonb,
	"ip" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(150) NOT NULL,
	"contact_name" varchar(150),
	"contact_email" varchar(150),
	"contact_phone" varchar(50),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "customers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "retired_zone_slugs" (
	"slug" varchar(100) PRIMARY KEY NOT NULL,
	"customer_id" uuid,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(150),
	"role" varchar(20) NOT NULL,
	"customer_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "chk_users_role_customer" CHECK (("users"."role" = 'admin' AND "users"."customer_id" IS NULL) OR ("users"."role" IN ('manager','viewer') AND "users"."customer_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
-- [elle düzenlendi] Mevcut bölgeler "Meven ArGe" müşterisine bağlanır:
-- önce NULL'a izin veren sütun, sonra müşteri + backfill, en son NOT NULL.
ALTER TABLE "zones" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
INSERT INTO "customers" ("slug", "name") VALUES ('meven-arge', 'Meven ArGe') ON CONFLICT ("slug") DO NOTHING;--> statement-breakpoint
UPDATE "zones" SET "customer_id" = (SELECT "id" FROM "customers" WHERE "slug" = 'meven-arge') WHERE "customer_id" IS NULL;--> statement-breakpoint
ALTER TABLE "zones" ALTER COLUMN "customer_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_customer_at" ON "audit_log" USING btree ("customer_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_log_at" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_users_customer_id" ON "users" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zones_customer_id" ON "zones" USING btree ("customer_id");