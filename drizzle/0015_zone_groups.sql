CREATE TABLE "device_zone_sync" (
	"mac" varchar(100) PRIMARY KEY NOT NULL,
	"reported" text[],
	"reported_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'unknown' NOT NULL,
	"last_error" varchar(200),
	"last_error_at" timestamp with time zone,
	"unsupported_fw" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "zone_group_members" (
	"group_id" uuid NOT NULL,
	"device_id" varchar(100) NOT NULL,
	CONSTRAINT "zone_group_members_group_id_device_id_pk" PRIMARY KEY("group_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "zone_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"slug" varchar(32) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "zone_groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "zone_group_members" ADD CONSTRAINT "zone_group_members_group_id_zone_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."zone_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_groups" ADD CONSTRAINT "zone_groups_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zone_group_members_device" ON "zone_group_members" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_zone_groups_zone_id" ON "zone_groups" USING btree ("zone_id");