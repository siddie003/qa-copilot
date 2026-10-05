ALTER TABLE "issue_status_event" ADD COLUMN "scan_id" uuid;--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_status_event" ADD CONSTRAINT "issue_status_event_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_status_created_idx" ON "report" USING btree ("status","created_at");--> statement-breakpoint
UPDATE "scanner_run" SET "status_reason" = 'Reports are generated on demand for finished scans (Reports tab), not during the scan.' WHERE "step_key" = 'report' AND "status" = 'skipped';
