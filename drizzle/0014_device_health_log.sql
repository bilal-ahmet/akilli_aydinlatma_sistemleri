CREATE TABLE "device_health_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"health" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_device_health_log_device_recorded" ON "device_health_log" USING btree ("device_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_device_health_log_recorded_at" ON "device_health_log" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_d4i_telemetry_device_recorded" ON "d4i_telemetry" USING btree ("device_id","recorded_at" DESC NULLS LAST);