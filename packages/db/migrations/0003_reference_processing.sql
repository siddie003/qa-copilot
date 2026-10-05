ALTER TYPE "public"."reference_status" ADD VALUE 'processing' BEFORE 'ready';--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "target_path" text;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "block_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_spec" ADD COLUMN "origin" varchar(32) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "design_spec" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "design_spec" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page_capture" ADD COLUMN "text_content_key" text;--> statement-breakpoint
ALTER TABLE "design_spec" ADD CONSTRAINT "design_spec_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;