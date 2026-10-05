import { issueStatusChangeSchema } from "@qa/core";
import { authedHandler } from "@/server/api";
import { json, readJson } from "@/server/http";
import { changeStatus, getIssue } from "@/server/issues";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Sets the status of an issue ({status, note?}); every change is recorded in its history. */
export const PATCH = authedHandler<Params>(
  "PATCH /api/v1/issues/:id/status",
  async (req, { user, params, log }) => {
    const { id } = await params;
    const input = await readJson(req, issueStatusChangeSchema);
    const result = await changeStatus(user.id, [id], input);
    log.info(
      { issueId: id, userId: user.id, status: input.status, changed: result.changed.length > 0 },
      "issue status change",
    );
    const detail = await getIssue(user.id, id);
    return json({
      changed: result.changed.length > 0,
      status: detail.status,
      history: detail.history,
    });
  },
);
