ALTER TABLE "ai_run" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "grounding_check" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "rule_id" varchar(128);--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "severity_rationale" text;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "verdict" "finding_verdict" DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "ai_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_ai_run_id_ai_run_id_fk" FOREIGN KEY ("ai_run_id") REFERENCES "public"."ai_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_run_scan_idx" ON "ai_run" USING btree ("scan_id");--> statement-breakpoint
ALTER TABLE "issue_finding" ADD CONSTRAINT "issue_finding_finding_uq" UNIQUE("raw_finding_id");