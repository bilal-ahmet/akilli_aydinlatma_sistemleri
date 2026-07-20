CREATE TABLE "fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"channel" integer NOT NULL,
	"name" varchar(100),
	"brightness" integer DEFAULT 0 NOT NULL,
	"is_on" boolean DEFAULT false NOT NULL,
	"active_fx" integer,
	"status" varchar(20) DEFAULT 'ok' NOT NULL,
	"last_seen" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_fixtures_device_channel" UNIQUE("device_id","channel")
);
--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "channel" integer;--> statement-breakpoint
CREATE INDEX "idx_fixtures_device_id" ON "fixtures" USING btree ("device_id");