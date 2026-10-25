CREATE TABLE "poles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100),
	"lat" double precision,
	"lng" double precision,
	"location_source" varchar(10),
	"location_accuracy_m" real,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "pole_id" uuid;--> statement-breakpoint
ALTER TABLE "poles" ADD CONSTRAINT "poles_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_poles_zone_code" ON "poles" USING btree ("zone_id","code");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_pole_id_poles_id_fk" FOREIGN KEY ("pole_id") REFERENCES "public"."poles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_pole_id_unique" UNIQUE("pole_id");