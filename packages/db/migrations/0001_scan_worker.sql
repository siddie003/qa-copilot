ALTER TABLE "page" ADD COLUMN "response_headers" jsonb;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "raw_html_key" text;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "worker_id" varchar(128);--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "scan_status_created_idx" ON "scan" USING btree ("status","created_at");