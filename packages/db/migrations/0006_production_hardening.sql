-- Before the constraint: a project with more than one active scan keeps its running scan (or its
-- oldest queued scan); queued duplicates are cancelled with a reason instead of failing the index.
WITH duplicates AS (
	UPDATE "scan" SET "status" = 'cancelled', "finished_at" = now(), "error" = 'Cancelled by an upgrade: another scan of this project was already queued or running.'
	WHERE "status" = 'queued' AND EXISTS (
		SELECT 1 FROM "scan" AS other
		WHERE other."project_id" = "scan"."project_id" AND other."id" <> "scan"."id"
			AND (other."status" = 'running' OR (other."status" = 'queued' AND (other."created_at", other."id") < ("scan"."created_at", "scan"."id")))
	)
	RETURNING "id"
)
UPDATE "scanner_run" SET "status" = 'skipped', "status_reason" = 'Scan cancelled before it started'
WHERE "scan_id" IN (SELECT "id" FROM duplicates) AND "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "scan_one_active_per_project_uq" ON "scan" USING btree ("project_id") WHERE status in ('queued', 'running');
