ALTER TYPE "public"."reference_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "outcome" varchar(32);--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_source" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
-- References read before outcomes were recorded: a ready reference was read in full.
UPDATE "reference_source" SET "outcome" = 'completed' WHERE "status" = 'ready';
