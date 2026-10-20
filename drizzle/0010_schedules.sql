CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" varchar(100),
	"enabled" boolean DEFAULT true NOT NULL,
	"action" varchar(20) NOT NULL,
	"value" integer,
	"effect_number" integer,
	"effect_text" varchar(32),
	"target" jsonb NOT NULL,
	"time_kind" varchar(10) NOT NULL,
	"time_minutes" integer,
	"offset_minutes" integer DEFAULT 0 NOT NULL,
	"repeat" varchar(10) NOT NULL,
	"run_date" varchar(10),
	"weekdays" integer,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_result" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_schedules_customer_id" ON "schedules" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_next_run_at" ON "schedules" USING btree ("next_run_at");