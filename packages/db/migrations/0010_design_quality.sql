CREATE TABLE "project_font" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"format" varchar(8) NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_font_project_sha_uq" UNIQUE("project_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "project_page_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"link_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_page_link_project_key_uq" UNIQUE("project_id","link_key")
);
--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "origin" varchar(16) DEFAULT 'crawl' NOT NULL;--> statement-breakpoint
ALTER TABLE "page_capture" ADD COLUMN "quality_key" text;--> statement-breakpoint
ALTER TABLE "project_font" ADD CONSTRAINT "project_font_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_page_link" ADD CONSTRAINT "project_page_link_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;