CREATE TABLE "d4i_telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"channel" integer NOT NULL,
	"online" boolean,
	"d4i_supported" boolean DEFAULT false NOT NULL,
	"status_byte" integer,
	"actual_level" integer,
	"min_level" integer,
	"max_level" integer,
	"physical_min_level" integer,
	"lamp_failure" boolean,
	"lamp_power_on" boolean,
	"control_gear_present" boolean,
	"energy_wh" double precision,
	"power_w" double precision,
	"driver_temperature_c" integer,
	"driver_voltage_v" integer,
	"driver_operating_time_s" integer,
	"led_temperature_c" integer,
	"led_voltage_v" double precision,
	"led_current_a" double precision,
	"raw" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error" varchar(200);--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_d4i_telemetry_device_channel" ON "d4i_telemetry" USING btree ("device_id","channel");--> statement-breakpoint
CREATE INDEX "idx_d4i_telemetry_recorded_at" ON "d4i_telemetry" USING btree ("recorded_at" DESC NULLS LAST);