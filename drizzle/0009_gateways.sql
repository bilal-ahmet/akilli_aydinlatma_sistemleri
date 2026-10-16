CREATE TABLE "gateways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway_id" varchar(100) NOT NULL,
	"customer_id" uuid NOT NULL,
	"zone_id" uuid,
	"type" varchar(30) NOT NULL,
	"name" varchar(100),
	"location" varchar(200),
	"notes" text,
	"firmware_version" varchar(32),
	"last_seen" timestamp with time zone,
	"online" boolean,
	"health" jsonb,
	"health_at" timestamp with time zone,
	"report" jsonb,
	"report_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "gateways_gateway_id_unique" UNIQUE("gateway_id")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "gateway_id" varchar(100);--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gateways_customer_id" ON "gateways" USING btree ("customer_id");