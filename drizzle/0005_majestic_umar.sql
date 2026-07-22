CREATE TABLE "fault_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(100) NOT NULL,
	"channel" integer,
	"code" varchar(60) NOT NULL,
	"detail" varchar(300),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_fault_events_device_started" ON "fault_events" USING btree ("device_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_fault_events_open" ON "fault_events" USING btree ("device_id","channel","resolved_at");