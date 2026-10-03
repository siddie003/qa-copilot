CREATE TABLE "project_secret" (
	"project_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"ciphertext" text NOT NULL,
	"summary" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secret_project_kind_uq" UNIQUE("project_id","kind")
);
--> statement-breakpoint
ALTER TABLE "network_request" ALTER COLUMN "from_cache" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "network_request" ALTER COLUMN "from_cache" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "page_capture" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "scanner_run" ADD COLUMN "checks" jsonb;--> statement-breakpoint
ALTER TABLE "project_secret" ADD CONSTRAINT "project_secret_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Earlier scans stored false for "not observable"; make that explicit.
UPDATE "network_request" SET "from_cache" = NULL;
