CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" varchar(100) NOT NULL,
	"action" varchar(20) NOT NULL,
	"value" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"delivered_at" timestamp with time zone,
	CONSTRAINT "commands_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "device_status" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"action" varchar(20),
	"value" integer,
	"status" varchar(20),
	"rssi" integer,
	"recorded_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"zone_id" uuid,
	"name" varchar(100),
	"last_seen" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "devices_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"district" varchar(100),
	"pole_count" integer DEFAULT 0 NOT NULL,
	"is_on" boolean DEFAULT false NOT NULL,
	"brightness" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "zones_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_device_status_device_id" ON "device_status" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_device_status_recorded_at" ON "device_status" USING btree ("recorded_at" DESC NULLS LAST);