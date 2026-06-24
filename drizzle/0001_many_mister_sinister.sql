ALTER TABLE "device_status" ADD COLUMN "brightness" integer;--> statement-breakpoint
ALTER TABLE "device_status" ADD COLUMN "relay_status" varchar(8);--> statement-breakpoint
ALTER TABLE "device_status" ADD COLUMN "temperature" integer;