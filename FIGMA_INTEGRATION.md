# Figma Integration

QA Copilot reads design values (text styles, color styles, button components, a container frame)
from Figma files through the **official Figma REST API** and turns them into a *draft* design
reference that a person reviews and confirms before scans use it. Nothing is scraped and nothing
is invented: values come only from what the API returned, each with the Figma node it came from.
Implemented in Phase 6; multi-page processing, manifests, resume and rate-limit handling added in
Phase 14 (2026-10-09).

## 0. Live verification (2026-10-10)

First real use of the Figma API on this installation (personal access token in `.env` as
`FIGMA_ACCESS_TOKEN`; file "Ascendion_Dev" linked by the DEMO2 project, account role: viewer).
Run on the disposable test database through the app (worker + API), not on user data.

- `GET /v1/files/:key/meta` answered with name and version — the token works.
- A link with `node-id` (one frame) was read with **1 Tier 1 request + 1 Tier 3 request**, no
  retries, in about 5–8 s: page "T2-AAVA_option_00", 11 frames inventoried, 9 tokens extracted
  (4 brand colors, H1–H3 and body typography, container width), every value citing its style.
- Draft confirmed → design comparison against `https://ascendion.com/aava/` (3 pages, desktop):
  13 matched, 9 mismatched, 3 need review, 2 unable to verify.
- **Defect found and fixed:** text colors were taken from the *first* layer using a text style,
  but Figma text styles have no color — each layer has its own fill. In this file one style was
  used with up to 6 colors, which produced "confirmed" color mismatches that the design does not
  support. A text color is now taken only when every layer with the style uses the same fill;
  otherwise the report says "used with N different colors; no text color taken". Unit test added.
- A style used with a single color in the linked frame still yields that color (e.g. "Body/Body-M"
  → #00fac2 in this frame); such values should be checked in the draft review before confirming.
- Tier 1 requests used by this verification: 2 (View/Collab seats get very few per month).

## 1. Official API facts (checked 2026-10-09)

From developers.figma.com/docs/rest-api (file endpoints, rate limits, authentication):

| Endpoint | Tier | Scope | Used for |
|---|---|---|---|
| `GET /v1/files/:key/meta` | 3 | `file_metadata:read` | Name and current version — the "unchanged?" check |
| `GET /v1/files/:key` (`depth`, `version`) | 1 | `file_content:read` | Whole file, or `depth=1` for the page list |
| `GET /v1/files/:key/nodes` (`ids`, `version`) | 1 | `file_content:read` | Several pages (or linked frames) in one request |

- `:key` may be a **file key or a branch key**.
- Auth header `X-Figma-Token` (personal access token); invalid or expired tokens and missing
  access return **403**; unknown files **404**; invalid parameters **400** with `err`. A `nodes`
  map entry is `null` for an id that is not in the file.
- No pagination exists on these endpoints; `ids`/`depth` limit the response.
- **Rate limits** (in effect since 2025-11-17) are per user and **per plan of the file**:
  - Tier 1 (file content): **View/Collab seats: up to 20 requests per month** (Figma notes it may
    be lower under load); Full/Dev seats: 10/min (Starter), 15/min (Professional), 20/min
    (Organization). Enterprise values could not be read reliably from the page.
  - Tier 3 (metadata): View/Collab up to 10/min; Full/Dev 50–150/min by plan.
  - Exceeding a limit returns **429** with `Retry-After` (seconds), `X-Figma-Plan-Tier`,
    `X-Figma-Rate-Limit-Type` (`low` = View/Collab seat, `high` = Full/Dev seat) and
    `X-Figma-Upgrade-Link`. Figma may change these limits at any time.
- Not used: Variables (Enterprise API), image renders, comments, versions list.

**Consequence:** file-content requests are scarce, especially for View/Collab seats. The design
below spends as few of them as possible and never re-reads what it already has.

## 2. How a Figma reference is read

```
Fetch (worker, one reference at a time)
 1. GET meta (Tier 3) ── version unchanged since a complete read? → done, no Tier 1 request
 2. link with node-id ── GET nodes?ids=<linked ids>                         (1 Tier 1 request)
 3. otherwise:
      previous read was page by page? ── no → GET file (whole)               (1 Tier 1 request)
                                                 larger than FIGMA_MAX_RESPONSE_MB ↓
      GET file?depth=1 → page list + version                                (1 Tier 1 request)
      GET nodes?ids=<up to FIGMA_PAGES_PER_REQUEST pages>&version=<listed>   (1 per batch)
        · batch too large or HTTP 5xx → split in halves (batch size adapts)
        · single page too large / still 5xx → that page is "failed", the rest continue
        · after each batch: manifest + checkpoint saved
 4. values of all pages read → draft design reference (reviewed before use)
```

- **Version pinning:** every page request carries the version from the page list, so a file
  edited during a read never mixes versions. A continued read whose file changed meanwhile starts
  over (and says so).
- **Results equal a whole-file read** (tested): the page-by-page path collects the same values in
  the same order.
- **Per-page isolation:** a page that is too large or that Figma cannot return is recorded with
  its reason; the other pages are read.

## 3. Rate limits, retries, cancellation, resume

- 429 with a `Retry-After` up to `FIGMA_MAX_RETRY_WAIT_MS` (default 60 s) is waited for and
  retried (`FIGMA_MAX_RETRIES`, default 3); 5xx and network errors are retried with jittered
  backoff.
- A longer wait (e.g. a monthly View-seat cap) **stops** the read: pages read so far are kept,
  a draft is created from them (labelled **Partial**), and the plan tier, seat type, wait and
  Figma's upgrade link are shown. **Continue reading** later requests only the missing pages.
- **Cancel** (References page or `POST /api/v1/projects/:id/references/:refId/cancel`): a queued
  reference is cancelled at once; a running read stops before its next request (heartbeat every
  5 s, and after every batch).
- **Worker crash:** a stale read is re-queued and continues from its checkpoint (3 attempts),
  then fails with a retry hint.
- Errors that cannot be fixed by waiting (token rejected, file not found, bad request, response
  too large for a linked node) fail the read and discard the checkpoint.

## 4. Manifest and states

Persisted on `reference_source.manifest` after every batch: file key, name, version, last
modified, read mode (`whole_file` / `pages` / `nodes`), pages discovered, **every page** with
status (done / failed with reason / pending), its top-level frames (id, name, type, size; up to
200 per page listed, total counted), node/text/component counts, requests per tier (summed over
runs), retries, rate-limit details, warnings, number of runs, complete flag, timestamps, and when
an unchanged check skipped fetching. The checkpoint (`reference_source.checkpoint`) holds the
pinned version, pending page ids and the values collected so far.

| State shown | Meaning |
|---|---|
| Queued / Processing | Waiting / being read (Cancel available) |
| Ready | All pages read |
| Ready with warnings | All pages read; e.g. the file had to be read page by page, or metadata could not be checked |
| Partial | Some pages failed, or the read stopped early (rate limit, network) — counts and reasons shown; **Continue reading** when pages are pending |
| Failed | Nothing could be read (reason shown) |
| Cancelled | Stopped by a user; Continue reading resumes |
| Unavailable | No token configured |

The References page shows "N of M pages read · failed · not read yet · frames · version · read
mode", requests used per tier, rate-limit details, warnings, failed pages with reasons and the
full page list. Values found and not used are listed with their totals (nothing is cut silently).

## 5. Comparison with the website

Unchanged from Phase 6 and deliberately conservative: only values actually returned by Figma are
compared (typography roles, palette colors, primary/secondary buttons, container width), each
mapped to website elements by explicit selector, semantic HTML or class heuristics with a
confidence; uncertain mappings are reported as **Unable to verify** or **Needs review**, never as
confirmed mismatches. Frames are inventoried (names, sizes) but not matched to website pages, and
no pixel comparison is made (not implemented; see limitations).

## 6. Setup (Windows / PowerShell)

1. In Figma's account settings, generate a personal access token with the scope
   `file_content:read` and, to enable the unchanged-version check, `file_metadata:read` (the exact
   labels in Figma's settings screen were not verified here). The token's account must have
   access to the file. Note the expiry you choose.
2. Save it either per project (References page → Figma access; stored encrypted with
   `ENCRYPTION_KEY`, never shown again) or server-wide in `.env` as `FIGMA_ACCESS_TOKEN`.
   Never paste a token into ordinary project fields.
3. Add the Figma link on the References page (file link, frame link with `node-id`, or a branch
   link `…/design/<key>/branch/<branchKey>/…`).
4. Review and confirm the draft design reference.

| Variable | Default | Meaning |
|---|---|---|
| `FIGMA_ACCESS_TOKEN` | — | Server-wide token (project tokens take precedence) |
| `FIGMA_MAX_RESPONSE_MB` | 50 | Largest response read; larger files are read page by page |
| `FIGMA_PAGES_PER_REQUEST` | 10 | Pages per `nodes` request (fewer requests = less quota) |
| `FIGMA_TIMEOUT_MS` | 120000 | Per request |
| `FIGMA_MAX_RETRIES` | 3 | Retries after short 429 waits, 5xx, network errors |
| `FIGMA_MAX_RETRY_WAIT_MS` | 60000 | Longest `Retry-After` waited for; longer stops the read (Partial) |

## 7. Troubleshooting

| Message | Do this |
|---|---|
| "No Figma access token is configured" | Save a token for the project or set `FIGMA_ACCESS_TOKEN` |
| "rejected the access token…" | Token expired, revoked, missing `file_content:read`, or the account cannot open the file |
| "file or node not found" | Check the link; the file must be shared with the token's account |
| "File metadata could not be read" (warning) | Add `file_metadata:read` to the token to enable the unchanged check (the file was still read) |
| "rate limit was reached … View or Collab seat" | That seat type gets very few file requests per month; wait (Continue reading later) or use a Full/Dev seat |
| "This page is larger than … MB" | Link a frame of that page instead, or raise `FIGMA_MAX_RESPONSE_MB` |
| "linked node is larger than … MB" | Link a smaller frame |

## 8. Security

Tokens are stored encrypted per project (AES-256-GCM, bound to the project id) or in the server
environment, sent only in the `X-Figma-Token` header to the fixed API host (`redirect: error`),
redacted from logs, and never returned by the API or shown in the UI. Only file keys, node ids and
the pinned version are sent. Responses are size-capped and parsed as data. The upgrade link from
Figma's 429 header is shown only if it points to figma.com. Manifests sent to the browser omit
frame lists.

## 9. Tests

Mock tests only — **no live Figma request has been made** (no token in this installation):
`packages/reference/src/figma-pages.test.ts` (whole file vs page by page on a generated 60-page
file with identical results, adaptive batch splitting, oversized page, missing page, short and
long 429 with plan headers, resume of only missing pages, file changed mid-read, unchanged check,
missing metadata scope, cancellation, linked nodes), `packages/reference/src/reference.test.ts`
(normalizer and client), `packages/core/src/figma.test.ts` (links incl. branches),
`apps/web/src/components/references/figma-manifest.test.ts` (rendered summary, link host check),
and on the real test database `apps/worker/src/references/figma.int.test.ts` (45-page file read
page by page into a draft; rate-limit stop → Partial draft → continue with only the missing
pages; cancel → crash → resume; unchanged skip; HTTP 500 page isolated; rejected token) and
`apps/web/src/server/references-api.int.test.ts` (cancel route, ownership). The mock servers
follow the documented response shapes; real Figma responses may contain more fields.

## 10. Limitations

- Not verified against the live Figma API (no token available here).
- Only local styles used by nodes, Button components named Primary/Secondary and a "Container"
  frame become values; Variables (Enterprise), spacing scales, effects, grids and images are not
  read. Frames are inventoried, not compared; no pixel comparison.
- Batching reduces requests but cannot avoid Figma's per-seat limits; a View/Collab seat may only
  allow a few reads per month.
- One response (whole file or one batch) is held in the worker's memory up to
  `FIGMA_MAX_RESPONSE_MB` while parsed.
- Plan access tokens and OAuth apps are not implemented (personal access tokens only).
