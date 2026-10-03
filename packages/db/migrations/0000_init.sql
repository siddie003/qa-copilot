CREATE TYPE "public"."content_block_type" AS ENUM('heading', 'paragraph', 'list_item', 'cta', 'link', 'emphasis');--> statement-breakpoint
CREATE TYPE "public"."finding_verdict" AS ENUM('confirmed', 'potential', 'inconclusive', 'unable_to_verify');--> statement-breakpoint
CREATE TYPE "public"."grounding_status" AS ENUM('passed', 'partial', 'rejected', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."issue_origin" AS ENUM('ai', 'deterministic');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'in_progress', 'resolved', 'reopened', 'ignored', 'inconclusive');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."parse_status" AS ENUM('pending', 'parsing', 'parsed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reference_kind" AS ENUM('figma', 'manual', 'guideline_document');--> statement-breakpoint
CREATE TYPE "public"."reference_status" AS ENUM('pending', 'ready', 'failed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."report_format" AS ENUM('pdf', 'md', 'json');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'running', 'completed', 'completed_with_failures', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'inconclusive', 'skipped');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"order" integer NOT NULL,
	"type" "content_block_type" NOT NULL,
	"level" integer,
	"text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"href" text,
	"page_hint" text,
	"location" jsonb
);
--> statement-breakpoint
CREATE TABLE "content_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(127) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"parse_status" "parse_status" DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"reference_source_id" uuid,
	"version" integer NOT NULL,
	"tokens" jsonb NOT NULL,
	"confirmed_by_user" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_spec_project_version_uq" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" varchar(120) NOT NULL,
	"website_url" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"scan_defaults" jsonb NOT NULL,
	"scan_counter" integer DEFAULT 0 NOT NULL,
	"issue_counter" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reference_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "reference_kind" NOT NULL,
	"figma_url" text,
	"figma_file_key" text,
	"figma_node_ids" jsonb,
	"storage_key" text,
	"status" "reference_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_capture_id" uuid NOT NULL,
	"url" text NOT NULL,
	"resource_type" varchar(32) NOT NULL,
	"method" varchar(16) NOT NULL,
	"status" integer,
	"transfer_size" bigint,
	"decoded_size" bigint,
	"duration_ms" integer,
	"failure_text" text,
	"from_cache" boolean DEFAULT false NOT NULL,
	"is_mixed_content" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"final_url" text,
	"http_status" integer,
	"redirect_chain" jsonb,
	"depth" integer NOT NULL,
	"discovered_from" text,
	"title" text,
	"content_type" varchar(255),
	"crawl_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_scan_url_uq" UNIQUE("scan_id","normalized_url")
);
--> statement-breakpoint
CREATE TABLE "page_capture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"viewport" varchar(32) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"screenshot_key" text,
	"dom_snapshot_key" text,
	"computed_styles_key" text,
	"console_messages" jsonb,
	"timings" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_capture_page_viewport_uq" UNIQUE("page_id","viewport")
);
--> statement-breakpoint
CREATE TABLE "scan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"design_spec_id" uuid,
	"content_snapshot_hash" varchar(64),
	"technology" jsonb,
	"is_demo" boolean DEFAULT false NOT NULL,
	"triggered_by_user_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_project_number_uq" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "scanner_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"step_key" varchar(64) NOT NULL,
	"position" integer NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"error" text,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"tool_name" varchar(128),
	"tool_version" varchar(64),
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "scanner_run_scan_step_uq" UNIQUE("scan_id","step_key")
);
--> statement-breakpoint
CREATE TABLE "ai_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"status" "job_status" NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_finding_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"data" jsonb NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grounding_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"check_type" varchar(64) NOT NULL,
	"passed" boolean NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"category" varchar(64) NOT NULL,
	"subcategory" varchar(64),
	"severity" "severity" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"affected_urls" jsonb NOT NULL,
	"affected_element" text,
	"expected" text,
	"actual" text,
	"recommendation" text,
	"confidence" real NOT NULL,
	"origin" "issue_origin" NOT NULL,
	"grounding_status" "grounding_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_track_scan_uq" UNIQUE("track_id","scan_id")
);
--> statement-breakpoint
CREATE TABLE "issue_finding" (
	"issue_id" uuid NOT NULL,
	"raw_finding_id" uuid NOT NULL,
	CONSTRAINT "issue_finding_issue_id_raw_finding_id_pk" PRIMARY KEY("issue_id","raw_finding_id")
);
--> statement-breakpoint
CREATE TABLE "issue_status_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"from_status" "issue_status",
	"to_status" "issue_status" NOT NULL,
	"user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_track" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_no" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"severity" "severity" NOT NULL,
	"category" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"first_seen_scan_id" uuid,
	"last_seen_scan_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_track_project_fingerprint_uq" UNIQUE("project_id","fingerprint"),
	CONSTRAINT "issue_track_project_display_uq" UNIQUE("project_id","display_no")
);
--> statement-breakpoint
CREATE TABLE "raw_finding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"scanner_run_id" uuid NOT NULL,
	"page_id" uuid,
	"display_id" varchar(32) NOT NULL,
	"scanner" varchar(64) NOT NULL,
	"rule_id" varchar(128) NOT NULL,
	"category" varchar(64) NOT NULL,
	"subcategory" varchar(64),
	"title" text NOT NULL,
	"message" text NOT NULL,
	"proposed_severity" "severity" NOT NULL,
	"verdict" "finding_verdict" NOT NULL,
	"selector" text,
	"viewport" varchar(32),
	"confidence" real NOT NULL,
	"expected" text,
	"actual" text,
	"fingerprint" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_finding_scan_display_uq" UNIQUE("scan_id","display_id")
);
--> statement-breakpoint
CREATE TABLE "report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"format" "report_format" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"error" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scan_comparison" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"base_scan_id" uuid NOT NULL,
	"target_scan_id" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_comparison_pair_uq" UNIQUE("base_scan_id","target_scan_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_block" ADD CONSTRAINT "content_block_document_id_content_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."content_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_document" ADD CONSTRAINT "content_document_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_spec" ADD CONSTRAINT "design_spec_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_spec" ADD CONSTRAINT "design_spec_reference_source_id_reference_source_id_fk" FOREIGN KEY ("reference_source_id") REFERENCES "public"."reference_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_source" ADD CONSTRAINT "reference_source_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_request" ADD CONSTRAINT "network_request_page_capture_id_page_capture_id_fk" FOREIGN KEY ("page_capture_id") REFERENCES "public"."page_capture"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture" ADD CONSTRAINT "page_capture_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_design_spec_id_design_spec_id_fk" FOREIGN KEY ("design_spec_id") REFERENCES "public"."design_spec"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_triggered_by_user_id_user_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scanner_run" ADD CONSTRAINT "scanner_run_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_raw_finding_id_raw_finding_id_fk" FOREIGN KEY ("raw_finding_id") REFERENCES "public"."raw_finding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grounding_check" ADD CONSTRAINT "grounding_check_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_track_id_issue_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."issue_track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_finding" ADD CONSTRAINT "issue_finding_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_finding" ADD CONSTRAINT "issue_finding_raw_finding_id_raw_finding_id_fk" FOREIGN KEY ("raw_finding_id") REFERENCES "public"."raw_finding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_status_event" ADD CONSTRAINT "issue_status_event_track_id_issue_track_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."issue_track"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_status_event" ADD CONSTRAINT "issue_status_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_track" ADD CONSTRAINT "issue_track_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_track" ADD CONSTRAINT "issue_track_first_seen_scan_id_scan_id_fk" FOREIGN KEY ("first_seen_scan_id") REFERENCES "public"."scan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_track" ADD CONSTRAINT "issue_track_last_seen_scan_id_scan_id_fk" FOREIGN KEY ("last_seen_scan_id") REFERENCES "public"."scan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_finding" ADD CONSTRAINT "raw_finding_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_finding" ADD CONSTRAINT "raw_finding_scanner_run_id_scanner_run_id_fk" FOREIGN KEY ("scanner_run_id") REFERENCES "public"."scanner_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_finding" ADD CONSTRAINT "raw_finding_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_comparison" ADD CONSTRAINT "scan_comparison_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_comparison" ADD CONSTRAINT "scan_comparison_base_scan_id_scan_id_fk" FOREIGN KEY ("base_scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_comparison" ADD CONSTRAINT "scan_comparison_target_scan_id_scan_id_fk" FOREIGN KEY ("target_scan_id") REFERENCES "public"."scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "content_block_document_idx" ON "content_block" USING btree ("document_id","order");--> statement-breakpoint
CREATE INDEX "content_document_project_idx" ON "content_document" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_owner_idx" ON "project" USING btree ("owner_id","created_at") WHERE "project"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "reference_source_project_idx" ON "reference_source" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "network_request_capture_idx" ON "network_request" USING btree ("page_capture_id");--> statement-breakpoint
CREATE INDEX "scan_project_created_idx" ON "scan" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_finding_idx" ON "evidence" USING btree ("raw_finding_id");--> statement-breakpoint
CREATE INDEX "grounding_check_issue_idx" ON "grounding_check" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_scan_idx" ON "issue" USING btree ("scan_id","severity");--> statement-breakpoint
CREATE INDEX "issue_status_event_track_idx" ON "issue_status_event" USING btree ("track_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_track_project_status_idx" ON "issue_track" USING btree ("project_id","status","severity");--> statement-breakpoint
CREATE INDEX "raw_finding_scan_fingerprint_idx" ON "raw_finding" USING btree ("scan_id","fingerprint");--> statement-breakpoint
CREATE INDEX "raw_finding_page_idx" ON "raw_finding" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "report_scan_idx" ON "report" USING btree ("scan_id");