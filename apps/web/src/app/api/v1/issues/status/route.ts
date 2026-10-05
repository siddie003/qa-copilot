import { bulkIssueStatusSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { changeStatus } from "@/server/issues";

export const runtime = "nodejs";

/**
 * Bulk status change ({ids, status, note?}, at most 100 issues). All issues must belong to the
 * user; otherwise nothing is changed (404). Each actual change is recorded in the issue history.
 */
export const POST = authedHandler("POST /api/v1/issues/status", async (req, { user, log }) => {
  const input = await readJson(req, bulkIssueStatusSchema);
  const result = await changeStatus(user.id, input.ids, input);
  log.info(
    {
      userId: user.id,
      status: input.status,
      changed: result.changed.length,
      total: input.ids.length,
    },
    "bulk issue status change",
  );
  return json({ changed: result.changed, unchanged: result.unchanged });
});
