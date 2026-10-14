ALTER TABLE "devices" ADD COLUMN "firmware_version" varchar(32);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "health_at" timestamp with time zone;