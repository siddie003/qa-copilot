ALTER TYPE "public"."parse_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "content_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"heading_text" text,
	"page_hint" text,
	"page_start" integer,
	"page_end" integer,
	"block_start" integer NOT NULL,
	"block_end" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_estimate" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(heading_text, '') || ' ' || text)) STORED,
	CONSTRAINT "content_chunk_document_index_uq" UNIQUE("document_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "stage" varchar(32);--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_document" ADD COLUMN "extractor_version" varchar(32);--> statement-breakpoint
ALTER TABLE "content_chunk" ADD CONSTRAINT "content_chunk_document_id_content_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."content_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chunk" ADD CONSTRAINT "content_chunk_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_chunk_project_idx" ON "content_chunk" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "content_chunk_search_idx" ON "content_chunk" USING gin ("search");--> statement-breakpoint
CREATE INDEX "content_document_project_sha_idx" ON "content_document" USING btree ("project_id","sha256");--> statement-breakpoint
-- Documents parsed before coverage tracking: outcome from their stored extraction details. Their
-- chunks are built by the worker's indexing job (chunk_count = 0); coverage stays unknown until
-- the document is processed again.
UPDATE "content_document" SET "outcome" = CASE
		WHEN coalesce(("meta"->>'truncated')::boolean, false) THEN 'partial'
		WHEN jsonb_array_length(coalesce("meta"->'warnings', '[]'::jsonb)) > 0 THEN 'completed_with_warnings'
		ELSE 'completed'
	END
WHERE "parse_status" = 'parsed';
