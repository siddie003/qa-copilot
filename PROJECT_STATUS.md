# Project Status: QA Copilot

_Last updated: 2026-10-05_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03.
- **Phase 2: Database + Project Management.** Approved 2026-10-03.
- **Phase 3: Dashboard / UI.** Approved 2026-10-03.
- **Phase 4: Crawler + Playwright.** Approved 2026-10-03 (open issues fixed in "Fix Phase 4 open issues").
- **Phase 5: Six QA scanners.** Verified complete on 2026-10-04 before Phase 6 started
  (typecheck, lint, format clean; 249/249 tests).
- **Phase 6: References + design/content comparison.** Declared complete by the user on
  2026-10-04; re-verified before Phase 7 started (typecheck, lint, format clean; 280/280 tests).
- **Phase 7: AI interpretation + grounding.** Declared complete by the user on 2026-10-05;
  re-verified before Phase 8 started (typecheck clean; 357/357 tests).
- **Phase 8: Issue management + reporting.** Verified complete at the start of Phase 9
  (typecheck clean; 394/394 tests).
- **Phase 9: Scan history + comparison.** Declared complete by the user on 2026-10-05; re-verified
  before Phase 10 started (typecheck, lint, format clean; 426/426 tests).
- Every phase through 9 has a git checkpoint commit (see "Git checkpoints" below).

## Current phase
**Phase 10: Production hardening.** Implemented and verified on 2026-10-05. All planned phases
(0–10) are implemented. **Awaiting review.** No further phase is planned.

## Found at the start of Phase 10
- Phase 9 verified from the repository: typecheck/lint/format clean, 426/426 vitest; both
  databases at 6 migrations; working tree clean at `7a6180c`. Docs matched the code.
- Already in place: SSRF guard on every request/redirect/connection and a browser guard proxy
  (all special IPv4/IPv6 ranges verified blocked), upload validation, random storage keys,
  owner-scoped queries, parameterized SQL, encrypted secrets, log redaction, problem+json errors,
  same-origin checks, Better Auth per-IP sign-in limits, health/readiness endpoints, pino logs.
- Gaps found in the code (all fixed, see below): no script CSP (deferred from Phase 1), no API rate
  limits, spoofable client IP for sign-in limits, DOCX bombs with understated sizes passed the
  guard, document parsing could not be stopped, CR/LF accepted in credential headers, drizzle
  errors (with every query parameter) logged and shown, no database guard against two active
  scans per project, stale-job recovery only at worker start, a recovered scan could be
  overwritten, timed-out steps kept running (and stored data after the scan moved on), SIGTERM
  waited for whole scans, deleted projects kept running scans and credentials, Chromium accepted
  downloads, worker health only on loopback, `tsx` missing from production installs, no storage
  cleanup, no Docker/deployment docs.
- Blockers: none. Not available: Docker, live AI/Figma keys, the master requirements document
  (its §60 acceptance list) — Phase 10 followed the Phase 0 plan's Phase 10 row and the hardening
  checklist given with the phase.

## Phase 10 features implemented
- **Security:** nonce-based CSP + HSTS (`proxy.ts`); per-user rate limits (429 + Retry-After);
  per-account failed-sign-in lockout (10 / 15 min); `TRUSTED_PROXIES` / `CLIENT_IP_HEADER`;
  DOCX entries decompressed and measured before parsing (upload and worker); documents parsed in a
  worker thread (512 MB heap, hard time limit); control characters refused in site credentials;
  project deletion cancels scans and deletes credentials; database errors sanitized in logs and on
  records; Better Auth logs through pino; Chromium downloads refused; readiness coalesced.
- **Reliability:** unique index `scan_one_active_per_project_uq` (migration 0006, with duplicate
  cleanup); periodic, race-safe stale recovery (scans, documents, Figma, reports); heartbeat and
  final status bound to the owning worker; per-step abort signals (timed-out steps stop, no late
  findings); graceful shutdown with `WORKER_SHUTDOWN_GRACE_MS` (scans recorded as interrupted);
  final scan state recorded after database errors; storage garbage collector
  (`npm run storage:gc`, dry run by default).
- **Production:** `Dockerfile` (web/worker targets), `docker-compose.yml`, `.dockerignore`,
  `deploy.env.example` (unverified: no Docker); `docs/DEPLOYMENT.md`; `tsx` as a runtime
  dependency; `WORKER_HEALTH_HOST`; configuration warnings (logs + Settings page).
- **UI:** sign-in shows the lockout wait time; Settings lists production configuration checks;
  the deletion dialog explains the new effects; scan step links meet the WCAG 2.2 target size
  (found by the new acceptance test).

## Phase 10 tests (2026-10-05)
- Typecheck (root + all 12 workspaces), ESLint, Prettier: clean.
- `vitest`: **506 passed** (53 files: 33 unit / 391 tests, 20 integration / 115 tests; was 426 in
  45 files), 264 s. One earlier full run was abnormally slow (61 min) and vitest could not start the
  worker for one file ("Timeout waiting for worker to respond"; the other 505 tests passed); the
  rerun with per-test timings was normal and complete. New:
  - security (real database): IDOR matrix — 44 route calls on another user's resources all 404
    problem+json, plus list/filter/comparison variants, nothing changed afterwards; concurrent
    Start QA Scan → one 201, the others 409; rate limit → 429 + Retry-After after 30 project
    creations, other users unaffected; account lockout through the real `/api/auth` route with a
    forged IP per attempt (even the right password refused while locked); forged-size DOCX upload
    rejected with nothing stored; CR/LF credential header refused
  - worker reliability (real database, real Chromium, slow local site): a timed-out crawl stops
    (mutation check: without the step abort the crawl stored 11 more pages after the scan
    ended); a worker shutdown records the scan as interrupted; a scan recovered elsewhere is not
    overwritten; the worker loop's `stop({ graceMs })` (no new scans claimed); stale recovery once
    under concurrency; owner-bound heartbeat/finish; project deletion effects; migration 0006
    duplicate cleanup
  - uploads: forged-size bombs, unknown compression, out-of-range entries, 600 fuzzed/truncated/
    random files never throw, hostile file names; isolated parsing (same blocks as in-process,
    runaway parser stopped by the hard limit, memory-hungry parser stopped at its heap limit)
  - CSP builder, proxy (redirect, nonce per request, HSTS), rate limiter and lockout, config
    (new variables, warnings), error sanitization (`stripQueryParams`, `publicErrorMessage`,
    `errorFields`), credential control characters, SSRF special ranges (24 cases), Chromium
    download refusal (real browser), storage GC (plan rules; real folder + database)
  - adjusted: two Phase 7/8 integration tests created several unfinished scans in one project
    (impossible through the API and now refused by the database) — they finish the previous scan
    first; the reports test sets the finished status directly (`finishScan` only finishes running
    scans)
- `next build`: pass (every route dynamic). Playwright e2e: **10/10** (new
  `tests/e2e/acceptance.spec.ts`: sign-up form → project → approved content parsed by the
  isolated parser → scan from the UI → issue status with note → Markdown report downloaded →
  rescan of v2 (concurrent start refused) → comparison → Settings production checks → project
  deletion (credentials gone); security headers and the nonce on every script; no CSP violation on
  any page; axe at each step). Its first run found the target-size failure (fixed).
- Production runtime checks:
  - pruned install (`npm ci` → `npm run build` → `npm prune --omit=dev`, the Dockerfile sequence)
    started natively: web health 200, readiness 200 (7/7 migrations, path hidden), all 14 scripts
    of `/login` carry the CSP nonce, worker health 200 with all three loops, migrations via
    `node --import tsx`, 3 configuration warnings logged per process, no error lines
  - real browser on the production build: nonce on every script, client navigation, no console
    errors, an injected inline event handler blocked by the CSP
  - `npm run storage:gc` dry run on the real storage folder: 3 orphaned (empty) project folders
    from integration tests found, 12 newer ones kept by the age guard, referenced data untouched;
    nothing was deleted
  - migration 0006 applied to the development database (no duplicates existed)

## Found at the start of Phase 9
- Phase 8 verified from the repository: typecheck clean, 394/394 tests; Phase 0–8 docs match the
  code. Phases 6–8 were uncommitted (checkpoint commits created first, see "Git checkpoints").
- Already in place and reused: `issue_track` (stable identity per scanner rule / reference value,
  status, first/last seen), per-scan `issue` occurrences with `issue_finding` links, finding
  fingerprints, `issue_status_event` (system events with scan id), the `scan_comparison` table
  (Phase 2, never written), the Scan history tab (plain scan list with a "Phase 9" note), the
  bulk status API, the fixture site.
- No blockers. Gaps closed: no comparison of scans, user statuses were never reopened, the
  history tab had no history beyond a list, the fixture had no second version.

## Phase 9 features implemented
- **Comparison engine** (`@qa/core/comparison`, pure, browser-safe): every tracked issue of two
  finished scans is New / Reopened / Changed / Resolved / Persistent / Not rechecked / Newly
  checked, with finding-level detail (matched by fingerprint, viewport-class fallback) and a
  reason built from the records. Resolved only if the target re-checked every finding (scanner
  ran, page analyzable, viewport captured, no page-level or same-rule inconclusive check, no
  link-check limit, unchanged design/content reference); otherwise Not rechecked, and the
  reverse for New vs Newly checked. Reopened also covers issues seen before the base scan,
  absent from it and found again. Unable-to-verify states stay visible (a verdict change is
  "changed", never "resolved"). Performance lab-measurement differences (value, worst viewport)
  are shown but are not changes; a crossed threshold is. Scans without issue records are "not
  comparable" (steps still compared). Scanner/step status changes (now completes / no longer
  completes / other) and warnings (URL, scanners, viewports, crawl limits, references, partial
  scans).
- **Reopen logic** (`materializeScanIssues`): resolved before the scan started + found again with
  evidence → Reopened, `resolved_at` cleared, system event "Found again by this scan after it was
  marked resolved."; inconclusive occurrences and fixes claimed while the scan ran do not reopen;
  in progress / ignored kept; idempotent. Scans never resolve issues by themselves.
- **Data/API:** `comparisonsRepo` (records loader, track history, `scan_comparison` summary
  cache — existing table, **no migration**), `server/comparisons.ts`;
  `GET /api/v1/projects/:id/comparisons?base=&target=` (defaults to the latest comparable pair;
  400 reversed/same, 404 foreign/malformed, 409 unfinished/nothing to compare) and
  `GET /api/v1/projects/:id/history` (scans with issue counts, changes vs previous, trend).
- **UI (historical dashboard):** Scan history tab — latest changes (tiles link to the comparison
  filtered by category), issues-per-scan chart by severity (server-rendered SVG, bars link to
  that scan's comparison), scan picker, history table with needs-review / unable-to-verify counts
  and change badges, reasons for scans without a comparison. Compare page
  (`/projects/:id/history/compare`) — category tiles/filter, every issue with reason, severity,
  verdict, finding counts, current status and finding-level detail, scanner/step status table,
  warnings, "not comparable" explanations, and a one-click audited "Set N still-open issue(s) to
  Resolved" for the latest scan. "Compare with scan #n" on finished scans; change lines for recent
  scans on the dashboard (cached summaries only).
- Accessibility scanner now records pages beyond its 25-page limit as not analyzed.
- Fixture site versions v1/v2 (`POST /__fixture/variant`, `X-Fixture-Variant` request header,
  CLI/`DEMO_SITE_VARIANT`), documented with the expected comparison results.

## Phase 9 tests (2026-10-05)
- Typecheck (root + all workspaces), ESLint, Prettier: clean. `npm run check:tsx-capture`: pass.
- `vitest`: **426 passed** (45 files; was 394). New:
  - comparison engine (20): every category and its precedence, finding-level pairing (incl.
    viewport-class change), coverage rules (page not crawled / HTTP 500, scanner failed / skipped /
    not selected / inconclusive step, viewport missing / capture failed, page-level and same-rule
    inconclusive checks, link-check limit, design reference version / content documents changed),
    partly re-checked issues, persistent issues with pages that were not re-checked, reopened by
    status event and by reappearance (and newly checked when the base could not see it),
    unable-to-verify verdicts, performance measurement variance vs threshold crossing, not
    comparable scans, step directions, setting warnings, invalid pairs, page keys
  - scanner compatibility (3): gap-check labels exist in the scanners; `pageKey` = crawler
    normalization
  - API on the real database (7): nothing to compare (409), running scan (409), default pair and
    every category from records, cache row, failed scan not comparable, pair validation
    (400/404, other users and projects), reopen rule (resolved → reopened with event, inconclusive
    keeps resolved, idempotent, issue detail shows the event), fix claimed after the scan started
    not overruled (and reported as reappeared), history items / breakdown / trend / cache
  - **real fixture scans with Chromium (Phase 9 exit criterion):** v1 → v2 → v1 on one project:
    fixes resolved, new defect new, user-resolved issue reopened (status + event), `/wide` (HTTP
    500) not rechecked and then newly checked, link issue changed, nothing else changed; v1 vs v1
    zero new / resolved / reopened / changed
  - Phase 7 issue-step test updated for the reopen rule (resolved → reopened; in progress kept)
- `next build`: pass. Playwright e2e: **9/9** (new `tests/e2e/history.spec.ts`: two real scans
  with per-project variant header, API categories, history tiles = API counts, chart, table,
  compare page categories / links / finding details, category filter, reversed pair refused,
  "Compare with scan #1" from the scan page; axe and no horizontal overflow at 1440px and 390px).
  The new spec waits for its last page to settle (see "Known issues" for a timing-dependent server
  log line).
- Manual checks (production build, real worker, fixture; throwaway accounts deleted):
  - 3 scans (v1, v2 with one issue resolved by the user before, v1): #1→#2 = 2 new, 1 reopened,
    1 changed, 4 resolved, 30 persistent, 1 not rechecked; #2→#3 = 4 reopened, 1 changed,
    2 resolved, 1 newly checked; history, chart, compare page, confirm-resolved action (statuses
    and audit), newly-checked reason, dark mode, no console errors.
  - 2 scans of the same version with all six scanners: found TTFB 1523 → 1515 ms and the worst
    viewport flipping, which made performance issues "changed"; fixed (measurement rule) and
    re-checked: all 40 issues persistent.

## Found at the start of Phase 8
- Phase 7 verified from the repository: typecheck clean, 357/357 vitest; all Phase 0–7 docs match
  the code.
- Already in place and reused: `issue_track` (stable `ISSUE-n`, status, latest severity/title),
  per-scan `issue` occurrences with `issue_finding` links, `grounding_check`, `ai_run`, the
  `issue_status_event` and `report` tables (created in Phase 2, never written), the Issues pages
  (list with severity/status/category filters, linking to the per-scan issues page), Reports pages
  (empty list with a "Phase 8" note), evidence viewer, `@qa/storage`, the reference-worker job
  pattern, Playwright in `@qa/browser`.
- No blockers. Gaps closed in Phase 8: status changes were not possible and the status history
  table was never written; the scan pipeline planned a `report` step that was always skipped
  ("planned for Phase 8").

## Git checkpoints
Created at the start of Phase 9 (2026-10-05) on `main` without touching the working tree:
`5b2579b` Phase 6 (tree of `dfba1be`) and `8434ee8` Phases 7 + 8 (no intermediate snapshot
existed, so they share a commit). Phase 9 has its own commit ("Phase 9: scan history and
comparison"). Phase 10 is **not committed yet** (working tree on top of `7a6180c`); commit it
after review.

## Phase 8 features implemented
- **Issue explorer** (`/issues`, project Issues tab, `GET /api/v1/issues`,
  `GET /api/v1/projects/:id/issues`): filters for severity, status, verdict (confirmed / needs
  review / unable to verify), scanner, affected page URL, minimum confidence, last detected
  (24 h / 7 / 30 / 90 days), search by title or `ISSUE-n`, five sort orders, pagination; columns
  for verdict, confidence, affected pages, last scan and number of scans; row selection with a
  **bulk status change** (≤ 100, all-or-nothing on ownership, optional note).
- **Issue detail** (`/projects/:id/issues/:n`, `GET /api/v1/issues/:id`): description, affected
  pages, element, expected/actual, severity + rationale, confidence, how the text was produced,
  fix guidance, evidence-backed statements, every source finding with its evidence (screenshots,
  HTML, headers, measurements, diffs), grounding checks, all scans it occurred in (older
  occurrences via `?scan=`), status history; links from the findings view and scan issues page.
- **Audited status workflow** (`PATCH /api/v1/issues/:id/status`, `POST /api/v1/issues/status`):
  users set Open / In progress / Resolved / Ignored with an optional note; Inconclusive and
  Reopened stay system-only. Every change is an `issue_status_event` (user, time, from → to,
  note); `resolved_at` set/cleared; setting the same status again records nothing. Scans record
  first detection and evidence-based status changes (open ↔ inconclusive) as system events with
  the scan (`issue_status_event.scan_id`), without duplicates on re-runs; user statuses are kept.
- **Reports** (PDF, Markdown, JSON): requested for finished scans
  (`POST /api/v1/scans/:id/reports`, 202; 409 while the scan runs or the same format is already
  being generated), generated by a new **report worker loop** from stored records only
  (`packages/reports`: versioned JSON model `qa-copilot-report` v1, Markdown and HTML renderers;
  `renderPdf` in `@qa/browser` with JavaScript disabled and all requests blocked). Contents: scan
  settings, every pipeline step with failed/inconclusive/skipped reasons and comparison counts,
  checks that could not be verified, issue summary (severity, status, verdict, category,
  outstanding), AI usage, every issue with status at generation time, verdict wording ("Unable to
  verify from available evidence", "Needs review"), fix guidance and source findings (JSON: full
  evidence; screenshots referenced, not embedded); findings without issues (older scans) listed
  separately. Download (`GET /api/v1/reports/:id/download`, attachment, owner-checked), status,
  delete; Reports tab with scan/format choice, live status, download and delete; Reports button
  on finished scans; global Reports page with downloads.
- Scans no longer plan the never-run `report` step; migration `0005_issue_workflow_reports`
  (additive + rewording of old skipped report steps).

## Phase 8 tests (2026-10-05)
- Typecheck (root + all 12 workspaces), ESLint, Prettier: clean. `npm run check:tsx-capture`: pass.
- `vitest`: **394 passed** (41 files; was 357). New:
  - reports (unit): versioned, deterministic data; ordering; counts from data only; failed /
    inconclusive / skipped steps with reasons; comparison counts; AI summary; storage keys never
    exported; **Markdown and HTML escaping of injected website text** (script tags, links,
    images, headings, list markers, backticks); no external resources in the PDF template; empty
    scans; finding values not repeated and long values clipped (JSON keeps them whole); site
    technology and server listed separately
  - issue workflow API (real database): system detection events, evidence-based status events,
    idempotent re-materialization, list with latest-occurrence fields, every filter (URL,
    confidence, verdict, severity, status, search, date, invalid values ignored, pagination),
    owner scoping, detail with occurrences/findings/evidence/history, audited single changes
    (note, user, resolved_at), no event for unchanged status, system-only and invalid statuses
    rejected (400), foreign issues 404, cross-site writes 403, bulk change all-or-nothing, bulk
    validation, user statuses kept by later scans
  - reports API (real database): unfinished scan 409, queued 202, duplicate 409, format/scan
    validation, owner-only listing, download not ready 409, download headers and body, owner-only
    status/download, delete with file removal, no delete while running (409), stale recovery
  - report worker (real database, **real Chromium PDF**): JSON/Markdown/PDF generated from issues
    created by the real grounding step; same issues, statuses and findings as the database, every
    finding exactly once, inconclusive wording, failed/inconclusive steps; PDF text extracted and
    checked; scans without issues list their findings; storage failure fails only that report
  - fixture pipeline (real Chromium): a JSON report of the full fixture scan contains exactly the
    scan's issues, findings and steps
- `next build`: pass.
- Playwright e2e: **8/8** (new spec `tests/e2e/issues-reports.spec.ts`: explorer → issue detail,
  system history entry, audited status change with note and user, filters, bulk change, report
  request refused while scanning, PDF/Markdown/JSON generation through the worker, downloads with
  file names, JSON counts = API counts, delete with confirmation, global Reports page; axe and no
  horizontal overflow at 1440px and 390px on the detail, explorer-with-selection and reports
  pages). The e2e audit found a contrast failure on selected rows (fixed).
- Manual check (production build, real worker, fixture site, throwaway account deleted
  afterwards): 6-page scan → 32 issues from 57 findings; status change with note; JSON / Markdown
  / PDF reports (141 KB / 53 KB / 298 KB); explorer, bulk bar, issue detail (desktop and 390px),
  "needs review" issue, Reports tab and the PDF template inspected visually. Fixed from this
  check: word breaks in the PDF steps table, long finding values repeated in full, the HTTP server
  shown as site technology, the status badge wrapping in the table.

## Found at the start of Phase 7
- Phase 6 was complete and verified (280/280 tests) but not committed. Nothing was committed in
  this session; git object `dfba1be` (not on a branch) records the exact Phase 6 tree so Phase 6
  and Phase 7 can still be committed separately.
- Already in place from earlier phases and reused: AI environment variables (validated, redacted),
  tables `issue_track`, `issue`, `issue_finding`, `grounding_check`, `ai_run` (never written
  before), Issues pages and dashboard counts reading `issue_track`.

## Phase 7 features implemented
- **Provider abstraction** (`packages/ai`): Anthropic (official SDK, streaming, structured JSON
  output, `AI_EFFORT`, server-side refusal fallback for supported models, no sampling params),
  OpenAI-compatible (Chat Completions, strict JSON schema, retries) and none. Typed error codes;
  configuration errors stop further requests.
- **Deterministic pre-grouping**: one issue per scanner rule (design/content: per reference
  value), stable fingerprints = tracked identity, affected pages from findings and evidence,
  verdict, allowed severity band. **Deterministic issue text** from the findings plus a rule
  catalog with fix guidance for every rule the scanners emit.
- **Interpretation**: batches per category (bounded, website data escaped and declared untrusted,
  static cacheable system prompt), concurrency limit, time budget below the step timeout,
  failure isolation per batch.
- **Grounding validator** (deterministic): rejects AI text citing unknown, foreign or
  evidence-less findings; replaces fields with numbers/colors/URLs/paths/quotes/finding ids not
  in the evidence corpus; severity ±1 (never raised for unconfirmed findings); affected element
  must be a finding's element; every claim checked against the field it cites; "Unable to verify
  from available evidence." wording for inconclusive issues. AI never sets affected URLs,
  category, fingerprint, linked findings, verdict or confidence.
- **Pipeline**: steps `ai` (skipped with the reason without a provider) and `grounding` (always
  creates the issues). One issue per group per scan, tracks with stable `ISSUE-n` numbers, user
  statuses kept, each finding in exactly one issue (unique constraint), grounding checks stored in
  order, one `ai_run` per request (no prompts/responses stored). Idempotent re-runs. Raw findings
  and evidence are never modified.
- **AI-assisted brand-guideline reading** (deferred from Phase 6): AI values kept only if written
  in the cited line, literal values win, still a draft; citations marked "read with AI assistance".
- **UI/API**: scan Issues page (grounding summary, filters by origin/outcome, AI requests table,
  issue cards with description, pages, element, expected/actual, severity rationale, fix,
  evidence-backed statements, source findings and every check); `GET /api/v1/scans/:id/issues`;
  "View N issues" and step links on the scan page; ISSUE links on findings; Issues tab linked to
  the latest occurrence; AI settings in Settings; AI-assisted reading summary on References.
- Migration `0004_ai_interpretation` (additive). Docs: README (Issues and AI analysis), notes,
  changelog, architecture amendments, `.env.example`.

## Phase 7 tests (2026-10-04)
- Typecheck (root + all 11 workspaces), ESLint, Prettier: clean. `npm run check:tsx-capture`: pass.
- `vitest`: **357 passed** (37 files; was 280). New:
  - fact extraction and number rounding rules; grouping (stable fingerprints, coverage, facts,
    allowed severities); deterministic text and catalog coverage of all scanner rules; prompt
    escaping/bounding; structured-output schema shape
  - grounding: accepted text; **rejection of fabricated/foreign/evidence-less finding ids**;
    **replacement of fabricated URLs, colors, measurements, quotes, finding ids and paths**;
    length limits; total rejection; severity bounds; element; six claim cases; inconclusive
    wording; design reference values
  - batching by category, failure isolation, stop after configuration errors, abort; drafts with
    and without AI, discarded/missing output, failed requests explained on issues
  - Anthropic provider against a mock Messages API (request shape, headers, beta + fallbacks only
    for supported models, fallback usage accounting, refusal, truncation, invalid output, HTTP
    errors, timeout vs cancel); OpenAI-compatible provider (request shape, retries, refusal,
    truncation, auth); provider selection
  - guideline grounding (colors, typography, buttons, pt→px, weights, names, merge, input)
  - real database: issue steps without AI, with mixed AI output (passed/partial/rejected/failed/
    missing, ai_run rows, findings untouched), idempotency, user statuses kept, new numbers only
    for new problems, stop after auth error, no findings, foreign findings refused; AI-assisted
    guideline processing (grounded/fabricated values, failure fallback); issues API (shape,
    filter, ownership, malformed ids, planned steps)
  - **fixture pipeline with real Chromium**: AI skipped with reason, every finding in exactly one
    issue, one issue per rule, design/content one per value; Phase 5/6 assertions unchanged
- `next build`: pass. Playwright e2e: **7/7** (scan flow now checks the evidence-validation step,
  the scan Issues page with axe at 1440px and 390px and no overflow, issue↔finding links and the
  Issues tab link).
- Manual check (production build, real worker, real Anthropic SDK against a local mock API):
  32 issues from 57 findings: 20 AI text verified, 8 with an injected URL replaced, 4 rejected for
  fabricated finding ids; issue page states, checks and AI requests table verified visually and
  with axe (0 violations, no overflow at 1440px and 390px). Throwaway accounts deleted afterwards.

## Blockers found and fixed at the start of Phase 6
- `packages/storage` had never been committed: `.gitignore` pattern `storage/` also matched
  `packages/storage/`, so a fresh clone could not build. Fixed by anchoring it to `/storage/`
  (also in `.prettierignore`); the package is now visible to git and formatted.
- The setup wizard's last step still showed a disabled "Start QA Scan" with Phase 3 wording; it
  now uses the real Start QA Scan control. The Scan page's "scanners are added in Phase 5" note
  was also stale and has been corrected.

## Phase 6 features (completed)
- **DesignSpec** (`@qa/core/design-spec`): typography roles (h1–h6, body, link, button), palette
  colors with optional website roles, primary/secondary buttons, container width, spacing scale,
  optional CSS selectors and scope; **provenance on every token** (Figma node, document
  page/line/excerpt, or manual). Versioned in `design_spec`; drafts vs confirmed versions.
- **Figma** (`packages/reference`): REST client (fixed host, `X-Figma-Token`, 50 MB cap, mapped
  401/403/404/429 errors), normalizer for local text/color styles, Button components
  (Primary/Secondary variants, default state preferred) and a "Container" frame. Token from
  `FIGMA_ACCESS_TOKEN` or a per-project token stored encrypted (write-only API/UI). Without a
  token the reference is "Unavailable" with guidance; nothing is invented.
- **Brand guideline extraction**: deterministic, literal values only (hex/rgb colors with labels,
  font declarations, size/weight/line-height lines), each cited; result is a draft.
- **Draft workflow**: extracted values merge into one pending draft (manual values never
  overwritten); review table with every change and its source; confirm/discard; manual saves are
  refused while a draft is pending. Scans freeze the confirmed version (`scan.design_spec_id`).
- **Content documents**: upload (PDF/DOCX/TXT/MD, `MAX_UPLOAD_MB`), validation (extension +
  declared MIME + magic bytes, UTF-8, DOCX zip-bomb guard via the central directory), random
  storage keys; parsed by the worker into blocks (headings with levels, paragraphs, list items,
  links, CTAs with targets) with locations (PDF page, line, heading path) and page markers
  (`Page:` / `URL:` / `<!-- page: -->`). PDF headings recovered from font sizes; image-only PDFs
  fail with "no OCR". Page mapping per document; retry; delete. Scans freeze the parsed documents.
- **Reference worker loop** in the worker process (separate from scans; LISTEN + polling; stale
  jobs failed with a retry hint on start).
- **Capture**: computed styles of design roles + palette + web-font status (all viewports) and
  visible text blocks/links (widest viewport), only when the scan has references.
- **Design comparison**: explicit selector > semantic HTML > class heuristics (confidence);
  CIEDE2000 colors (≤ 2 match, 2–5 potential, > 5 mismatch), ±0.5px sizes, exact weights, first
  declared font family (+ failed web fonts); size-dependent values at the widest viewport by
  default; one finding per token aggregated across pages/viewports; palette near-misses
  (potential); roles present on the site but missing from the reference → unable to verify.
- **Content comparison**: page mapping (explicit 1.0 > name 0.8 > heading 0.75; ambiguous →
  unable to verify); exact/contained match, capitalization (potential), changed wording ≥ 0.85
  (confirmed only on explicitly mapped pages), rewritten ≥ 0.6 (potential), missing; CTA/link
  text and target compared separately; word-diff evidence with document citations.
- **UI**: References tab (design reference with draft review, sources, Figma token, token editor
  with JSON import/export; content documents with status, page mapping, text viewer, retry,
  delete; auto-refresh while processing); wizard steps 2–3 with Figma link, guideline upload,
  manual values and content uploads, and a final step with live processing status and Start QA
  Scan; Scan readiness; per-scan comparison report (all verdicts, filter); scanner results and
  live scan links; evidence viewer for word diffs, color swatches and computed-style tables;
  findings filter includes design/content.
- **API**: design-spec (GET/PUT, draft confirm/discard), guideline upload, content documents
  (list/upload/patch/delete/blocks/retry), reference refresh/delete, Figma token (PUT/DELETE).
- **Fixtures**: documented design/content defects on the demo site, `design-spec.json`,
  `approved-content.md`, a Figma REST fixture, and real DOCX/PDF builders for tests.

## Phase 6 tests (2026-10-04)
- Prettier, typecheck (root + all 10 workspaces), ESLint: pass. `npm run check:tsx-capture`: pass.
- `vitest`: **280 passed** (30 files; was 249), new:
  - extraction of real MD/TXT/DOCX/PDF files (headings, levels, lists, links, CTA targets,
    markers, PDF pages), failure cases (fake PDF, image-only PDF, code-only Markdown)
  - Figma normalization of the fixture file; REST client token header, node endpoint, 403/404/429/500
    and size cap; guideline extraction with citations
  - upload validation (types, MIME mismatch, UTF-8, zip bomb, ZIP-not-DOCX, file names)
  - design value comparison and verdict matrix; content mapping and verdict matrix; step planning
  - worker integration (real DB): document parsing in all formats, Figma via a local mock API
    (no token → unavailable, wrong token → failed, valid → draft → confirm, no-change refetch),
    guideline draft keeping manual values, stale recovery
  - API integration (real DB): uploads, rejections (fake PDF, .exe, bad path, oversize → 413),
    ownership isolation, draft conflicts/confirm/discard, encrypted write-only Figma token,
    reference freezing at scan start
  - **pipeline integration on the fixture with real Chromium: every design verdict (match,
    confirmed, potential, unable to verify) and all 13 content verdicts as documented**, styles
    per viewport and text only at the widest viewport; Phase 5 assertions unchanged and passing
- `next build`: pass.
- Playwright e2e: **7/7** (new: references page upload/editor → scan → comparison report →
  word-diff evidence; wizard with content upload and Start QA Scan; References page added to the
  accessibility audit at desktop and 390px: 0 violations, no overflow).
- Manual check in the browser (dev servers): wizard → project with manual values and a document →
  worker parsed it → scan → design 8 matched / 4 mismatched / 5 need review / 5 unable to verify,
  content 5 / 3 / 3 / 2; guideline upload produced a cited draft. This found two issues, both
  fixed: table pages overflowing at narrow widths (fieldset min-width; `sr-only` spans escaping
  scroll regions) and false palette near-misses from browser-default form-control colors.

## Known issues / limitations
- Figma: only local styles used by nodes, Button components named Primary/Secondary and a frame
  named "Container" are read; Variables (Enterprise API), spacing scales and visual (pixel) diffs
  against frames are not implemented. Not tested against the live Figma API (no token available);
  tested against a local mock that follows the documented REST response format.
- Guideline extraction: literal values, plus AI-assisted values when a provider is configured
  (Phase 7; kept only if written in the cited line).
- Design mapping of buttons/containers without explicit selectors relies on class-name
  heuristics (reported as potential, never confirmed); free-form alignment is not compared.
- Content: a block counts as present if its text appears anywhere on the mapped page; scanned
  PDFs (no OCR) and tables in PDFs are not structured.
- The pre-existing scroll-region tables (projects, scans) have the same latent `sr-only` overflow
  pattern fixed in the newer tables (the issues and reports tables were rebuilt in Phase 8 with
  the fix); they pass the current audits, so they were left unchanged.
- Observed in e2e logs: Next.js `MaxListenersExceededWarning` on the gzip stream (Next.js's built-in
  response compression; harmless, not investigated further — compression can be left to the reverse proxy),
  and once per full run, in a varying spec, "The destination stream closed early" (a streamed
  response aborted when the test navigates away; timing-dependent, no test fails, app unaffected).
- AI (Phase 7): not tested against the live Anthropic or OpenAI APIs (no key in this
  environment). Both providers are tested against local mocks of the documented wire formats, and
  the full worker path was exercised manually through the real SDK against such a mock. The
  server-side refusal fallback (beta) is therefore unverified live; set `AI_REFUSAL_FALLBACK=false`
  if an account rejects it. Fact grounding is a heuristic safety net: prose without numbers,
  colors, links, quotes or ids cannot be checked this way (claims and the severity bound limit the
  risk); in hyphenated ranges ("10-20px") only the first number is checked.
- Existing tracks are matched by fingerprint and keep user statuses, except the Phase 9 reopen
  rule (resolved + found again with evidence → Reopened). Scans run before Phase 7 have no issues
  (their findings stay available) and are not comparable at issue level (steps still are).
- The local `.env` sets `AI_TIMEOUT_MS=120000` and `AI_MAX_OUTPUT_TOKENS=8000` explicitly; the new
  defaults (300000 / 16000) only apply where those variables are unset.
- Reports (Phase 8) are snapshots: issue statuses are those at generation time (regenerate after
  changes). Markdown/PDF list up to 25 affected URLs per issue and 20 inconclusive checks per step
  (the JSON report has everything, including evidence). Reports are generated one at a time; each
  PDF launches its own short-lived Chromium (a few seconds).
- Explorer filters on verdict, confidence and URL use the latest occurrence of each issue.
- A user who sets an issue back to *Open* hands it back to the system: a later scan may set it to
  *Inconclusive* if the evidence becomes inconclusive (recorded as a system event).
- Stored files (screenshots, reports) are not removed automatically when rows disappear through
  database cascades (e.g. a deleted user); `npm run storage:gc` (Phase 10) finds and removes them
  on demand (dry run by default). Soft-deleted projects keep their files unless
  `--include-deleted-projects` is given.
- Scan comparison (Phase 9): an issue is one scanner rule across pages, so per-page differences
  show as "changed" with finding-level detail (new / no longer found / not rechecked per page).
  "Re-checked" relies on the scanners' stored inconclusive-check labels for page-level gaps (kept
  in step by a test). Performance values close to a threshold can cross it between runs (lab
  variance); that is reported as a change by design. Comparing scans of different hosts matches
  pages by path (a warning is shown). Scans never resolve issues by themselves; users confirm
  fixes (one click on the comparison of the latest scan). Reports cover one scan and do not include
  a comparison. The history page computes missing comparison summaries on first view (cached
  afterwards); the dashboard only shows cached ones.
- Dev-tool `npm audit` findings unchanged: `npm audit --omit=dev` reports 4 moderate advisories,
  all in the esbuild copy bundled by `drizzle-kit` (a development tool used only to generate
  migrations; the advisory concerns esbuild's dev server). ESLint 9 pin unchanged.
- Phase 10 (production hardening):
  - Docker image and Compose stack were written but not built or run (Docker not installed). The
    same build sequence (`npm ci` → `npm run build` → `npm prune --omit=dev` → start) was verified
    natively. OS signal handling (SIGTERM) could not be exercised on Windows; the shutdown logic is
    covered by integration tests.
  - Rate limits, the per-account sign-in lockout and Better Auth's per-IP limits are kept in the
    web process's memory: run one web instance (several instances would each enforce their own).
  - Anyone who knows an account's email address can trigger its sign-in lockout (10 wrong
    passwords; it lasts at most 15 minutes) — the usual trade-off of per-account limits.
  - Without a reverse proxy that overwrites `X-Forwarded-For`, clients choose the IP that the
    per-IP sign-in limits see (Next.js only sets the header when it is absent); the per-account
    limit does not depend on it. See docs/DEPLOYMENT.md.
  - The CSP allows inline `style` attributes (`style-src 'unsafe-inline'`; React style props);
    scripts are nonce-only. `'strict-dynamic'` trusts scripts created by running scripts.
  - Chromium runs without its own sandbox (Playwright's default); the deployment guide asks for an
    isolated worker with restricted egress. Not changed, to avoid breaking container setups.
  - The per-project page limit (`maxPages` up to 500) is not capped by the server's
    `SCAN_MAX_PAGES` (that variable is only the default), as before.
  - Integration tests and the development database share the repository's `storage/` folder
    (existing test setup), so the storage collector reports integration-test leftovers as
    orphans locally.

## Next phase
None planned: Phase 10 was the last phase of the Phase 0 roadmap. Waiting for review.

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required); `ENCRYPTION_KEY` (required to store site
credentials and project Figma tokens; required in production); `TEST_DATABASE_URL` for integration
tests; optional `FIGMA_ACCESS_TOKEN`, `MAX_UPLOAD_MB`; `SCAN_ALLOWED_PRIVATE_HOSTS`, `SCAN_*`,
`LINK_CHECK_RETRIES`, `WORKER_CONCURRENCY`; AI (optional): `AI_PROVIDER`, `AI_MODEL`,
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`), `AI_EFFORT`, `AI_REFUSAL_FALLBACK`,
`AI_CONCURRENCY`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_TEMPERATURE`. Phase 10 (optional):
`TRUSTED_PROXIES`, `CLIENT_IP_HEADER`, `RATE_LIMIT_ENABLED`, `WORKER_HEALTH_HOST`,
`WORKER_SHUTDOWN_GRACE_MS`. Production settings: docs/DEPLOYMENT.md. See `.env.example`.
