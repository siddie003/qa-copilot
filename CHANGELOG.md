# Changelog

## [Unreleased]

### Phase 9: Scan history and comparison (2026-10-05)
#### Added
- Comparison of two finished scans (`@qa/core/comparison`): new, reopened, changed, resolved,
  persistent, not rechecked and newly checked issues with finding-level detail and reasons;
  scanner/step status changes; warnings for different settings; "not comparable" for scans
  without issue records. Resolved only when the target scan re-checked every finding.
- Reopen logic: resolved issues found again with evidence become Reopened (audited system event).
- Scan history tab (latest changes, issues-per-scan chart, scan picker, history table), compare
  page with confirm-resolved action, "Compare with scan #n" on scans, changes on the dashboard.
- API `GET /api/v1/projects/:id/comparisons`, `GET /api/v1/projects/:id/history`; summaries
  cached in `scan_comparison`.
- Fixture site versions v1/v2 (`POST /__fixture/variant`, `X-Fixture-Variant` header).
- Unit, integration (real DB; real Chromium v1 → v2 → v1 scans) and end-to-end tests.
#### Changed
- The accessibility scanner reports pages beyond its 25-page limit as not analyzed.
- Issues that a user marked resolved are now reopened by a scan that finds them again with
  evidence (previously user statuses were always kept); the Phase 7 test was updated accordingly.
#### Fixed
- Comparisons do not report performance issues as changed when only a lab measurement varied
  between page loads (measured value or worst viewport); a crossed threshold still counts.

### Phase 8: Issue management and reporting (2026-10-05)
#### Added
- Issue explorer (all projects and per project): filters for severity, status, verdict
  (confirmed / needs review / unable to verify), scanner, affected page URL, minimum confidence and
  last detection, search by title or `ISSUE-n`, sorting, pagination; columns for verdict,
  confidence, affected pages, last scan and number of scans; row selection with bulk status change.
- Issue detail page (`/projects/:id/issues/:n`): description, affected pages, element,
  expected/actual, severity rationale, fix guidance, evidence-backed statements, every source
  finding with its evidence, grounding checks, all scans the issue was found in (older occurrences
  viewable) and the status history.
- Audited status workflow: Open, In progress, Resolved, Ignored with optional note; every change
  stored in `issue_status_event` with user, time, previous status and note; scans record first
  detection and evidence-based status changes as system events. Inconclusive and Reopened stay
  system-only. `resolved_at` maintained.
- Reports generated on demand from finished scans in PDF, Markdown and JSON (versioned schema
  `qa-copilot-report` v1): scan settings, all pipeline steps with failed/inconclusive/skipped
  reasons, checks that could not be verified, and every issue with status, verdict, fix guidance and
  source findings (JSON: full evidence). Built only from stored records; website text escaped;
  PDF rendered by Chromium with JavaScript disabled and the network blocked.
- `packages/reports`; report worker loop (LISTEN `report_queued`, stale recovery); `renderPdf` in
  `@qa/browser`; Reports tab with format choice, live status, download and delete; Reports button
  on finished scans; downloads on the global Reports page.
- API: `GET /api/v1/issues`, `GET /api/v1/projects/:id/issues`, `GET /api/v1/issues/:id`,
  `PATCH /api/v1/issues/:id/status`, `POST /api/v1/issues/status` (bulk),
  `GET/POST /api/v1/scans/:id/reports`, `GET/DELETE /api/v1/reports/:id`,
  `GET /api/v1/reports/:id/download`.
- Migration `0005_issue_workflow_reports` (`issue_status_event.scan_id`, `report.started_at`,
  report status index); unit, integration (real database, real Chromium PDF) and end-to-end tests.
#### Changed
- Scans no longer plan a "Report generation" step (reports are generated on demand); the reason on
  older scans' skipped report step was reworded by the migration.
- Issue links in the explorer, the findings view and the scan issues page open the issue detail
  page.
#### Fixed
- Nothing outstanding from Phase 7.

### Phase 7: AI interpretation and grounding (2026-10-04)
#### Added
- `packages/ai`: AI provider abstraction with three providers: Anthropic (official SDK,
  streaming, structured JSON output, opt-in server-side refusal fallback), OpenAI-compatible
  (Chat Completions with strict JSON schema, retries) and none.
- Deterministic pre-grouping of findings into issues (one issue per scanner rule; one per design
  token or content block) with stable fingerprints, facts (affected pages from findings and
  evidence, element counts, verdict, allowed severities) and deterministic issue text: scanner
  wording plus a rule catalog with fix guidance for every rule the scanners emit.
- AI interpretation in batches per category (bounded input, website data escaped and marked as
  untrusted, static cacheable system prompt, concurrency limit, time budget, failure isolation;
  configuration errors stop further requests).
- Deterministic grounding validator: rejects AI text citing findings that do not exist or belong
  to another issue (or without evidence); replaces any field whose numbers, colors, URLs, page
  paths, quotes or finding ids are not in the issue's evidence, counts, rule guidance or design
  reference; keeps severity within one level (never raised for unconfirmed findings); checks the
  affected element and every cited claim; enforces the "Unable to verify from available evidence"
  wording. AI never sets affected URLs, category, fingerprint, findings or confidence.
- Pipeline steps `ai` (AI analysis; skipped with the reason when no provider is configured) and
  `grounding` (evidence validation and issue creation; always runs). Issues are stored with
  tracks (stable `ISSUE-n` numbers per project, user statuses kept), finding links (each finding
  in exactly one issue, enforced by a unique constraint), grounding checks and one `ai_run` per AI
  request (tokens, latency, serving model, error; no prompts or responses stored).
- AI-assisted brand-guideline reading: values the AI proposes are kept only if written in the line
  they cite (colors, sizes with unit, weights, font names, named roles); literal values win; the
  result is still a draft to confirm; citations are marked "read with AI assistance".
- Scan issues page (per-scan interpretation and grounding report with filters, AI requests,
  source findings and every check), `GET /api/v1/scans/:id/issues`, "View issues" on the scan
  page, issue links on findings, Issues tab linked to the latest occurrence, AI settings shown in
  Settings, AI-assisted reading summary on the References page.
- Migration `0004_ai_interpretation`; config `AI_EFFORT`, `AI_REFUSAL_FALLBACK`,
  `AI_CONCURRENCY`; tests: provider mocks for both APIs, grounding (fabricated ids, URLs, values,
  quotes, paths, severity, claims), batching, issue materialization on the real database,
  guideline grounding, fixture pipeline coverage, API and end-to-end checks.
#### Changed
- Defaults: `AI_TIMEOUT_MS` 300000 (was 120000), `AI_MAX_OUTPUT_TOKENS` 16000 (was 8000).
- The findings view no longer says issues come "in a later phase".
#### Fixed
- Nothing outstanding from Phase 6.

### Phase 6: Design and content references, comparison (2026-10-04)
#### Added
- DesignSpec schema with per-token provenance, versioning with drafts and confirmation; token
  editor with JSON import/export (References page and setup wizard).
- `packages/reference`: Figma REST client and normalizer (text/color styles, Button
  Primary/Secondary components, Container frame); deterministic brand-guideline extraction with
  citations; content extraction from PDF (font-size headings, page numbers), DOCX, Markdown and
  TXT with page markers and CTA targets.
- Reference worker loop in the worker: parses uploaded documents, reads Figma files, extracts
  guideline drafts; stale-job recovery; status in the worker health endpoint.
- Document upload validation (extension, MIME, magic bytes, UTF-8, DOCX zip-bomb guard) and
  storage under random keys; per-project Figma token stored encrypted (write-only).
- Design comparison step (computed styles of mapped roles, CIEDE2000 colors, pixel tolerances,
  palette near-misses) and content comparison step (page mapping, exact / changed wording /
  rewritten / missing / capitalization, CTA text and targets, word-diff evidence); both report
  match, confirmed mismatch, potential mismatch and unable to verify.
- Capture of computed styles and visible text when a scan has references; scans freeze the
  confirmed design spec version and the parsed documents.
- References tab, comparison report per scan, evidence rendering for word diffs, color swatches
  and computed-style observations; findings filter for design/content; wizard steps for Figma,
  guideline, manual values and content uploads with live processing status.
- API: design spec, draft confirm/discard, guideline and content document uploads, document
  mapping/blocks/retry/delete, reference refresh/delete, Figma token.
- Migration `0003_reference_processing`; fixture design spec, approved content, Figma response and
  DOCX/PDF builders; unit, integration and end-to-end tests (280 vitest, 7 Playwright).
#### Changed
- Fixture website: documented design and content differences (stylesheet, About and Products copy).
- Responsive scanner: its design-spacing inconclusive check now points to the design comparison.
#### Fixed
- `packages/storage` was excluded from git by the `storage/` ignore pattern (now `/storage/`).
- Setup wizard's last step offered a disabled "Start QA Scan" with outdated wording; it now starts
  scans. Outdated Phase 4 note on the Scan page.

### Phase 5: Six QA scanners (2026-10-03)
#### Added
- `packages/scanners`: scanner contract (validated findings with mandatory evidence, check
  summaries with inconclusive checks), registry and six scanners: accessibility (axe-core + keyboard
  focus), security (passive configuration checks), SEO, broken links/mixed content, performance (lab
  Core Web Vitals and budgets), responsive/visual (layout measurements + live mobile-menu test).
- Capture collects lab Core Web Vitals (PerformanceObserver) and layout/image/render-blocking
  metrics; stored in `page_capture.metrics`.
- Findings persisted with per-scan display ids (A11Y-001 …), evidence rows and stable fingerprints;
  scanner check summaries in `scanner_run.checks`.
- Findings view with filters and evidence; findings counts on the scan page, Scanner results tab and
  dashboard; findings API.
- Fixture website: documented defects for every scanner, Basic-auth members area, slow page,
  valid generated PNG.
#### Changed
- Capture runs viewports in parallel and skips redirect duplicates; accessibility analysis runs
  three pages at a time (full fixture scan ~108 s → ~38 s).
- Redirecting URLs that reach an already-analyzed page are analyzed once (no duplicate findings).

### Phase 4 fixes (2026-10-03)
#### Fixed
- DNS-rebinding gap in Chromium closed with a local guard proxy.
- Bare `localhost:PORT` input defaults to http://; HTTPS handshake failures explain the scheme.
- `from_cache` stored as NULL (unknown) instead of false.
#### Added
- Site authentication (HTTP Basic, custom header, cookies), encrypted per project, sent to the
  scanned site only; settings UI and wizard step; scan-auth API.
- `WORKER_CONCURRENCY` for parallel scans per worker.

### Phase 4: Crawler, browser automation and live scans (2026-10-03)
#### Added
- Scan-time SSRF protection: DNS checks before every request and redirect hop, connect-time
  address pinning (undici dispatcher) against DNS rebinding, and an in-browser request guard;
  explicit allowlist for authorized internal hosts.
- Crawler: URL normalization, same-site scope, breadth-first crawl with page/depth limits,
  robots.txt (RFC 9309), redirect chains, retries for transient failures only, body size cap,
  JavaScript-rendered link discovery.
- Technology detection with explicit signals and confidence ("Could not determine" otherwise).
- Playwright capture per page and viewport: screenshot, rendered DOM, network requests, console
  messages, navigation timings; mobile emulation below 768 px.
- Artifact storage with strict key validation; authenticated artifact endpoint.
- Worker scan pipeline (preflight, crawl, capture) with per-step timeouts, heartbeats,
  cancellation and crash recovery; scan rows as the job queue (SKIP LOCKED).
- Start QA Scan with authorization confirmation; live scan page (SSE + polling fallback, cancel,
  technology, screenshots); one active scan per project.
- Migration status in readiness/Settings; the worker pauses while migrations are pending.
- Controlled fixture website and an end-to-end scan test.
#### Fixed
- In-page scripts are sent as strings so tsx/esbuild `__name` helpers cannot break them.

### Phase 3: Dashboard and UI (2026-10-03)
#### Added
- Dashboard backed by stored data: project and issue totals, outstanding issues by severity,
  scanner status of the latest scan, recent scans; empty states when nothing exists.
- Project sections: Overview, Scan (readiness checklist, configuration, disabled Start QA Scan),
  Issues, Pages, Scanner results, Reports, Scan history, Settings.
- Global Scans, Issues (search, severity/status/category filters, sorting, pagination) and Reports pages.
- Six-step project setup wizard (project, Figma/brand, content, scan configuration, review, start).
- Figma link parsing and storage as a pending design reference; URL check endpoint; dashboard API.
- UI components: toasts, breadcrumbs, pagination, severity/status badges, tooltips,
  confirmation dialog, stat tiles, cards. Account section in Settings.
- Read-model repositories (dashboard, scans, issues, pages, reports, references) with ownership checks.
- Playwright + axe-core end-to-end accessibility suite.
#### Fixed
- Horizontal overflow caused by hidden tooltips; scrollable tables and the wizard step list are
  now keyboard-focusable regions (found by the new accessibility suite).
- `updated_at` now uses the database clock (flaky timestamp comparison).

### Phase 2: Database + project management (2026-10-03)
#### Added
- Full PostgreSQL schema (24 tables) for users, projects, references, content, scans, scanner
  runs, pages, captures, network requests, raw findings, evidence, issue tracks, issues, grounding
  checks, AI runs, reports and scan comparisons; initial migration and migration runner.
- Email + password authentication (Better Auth): sign-up, sign-in, sign-out, database sessions,
  rate limiting, protected pages and API routes, optional sign-up switch.
- Project API (`/api/v1/projects`) with search, pagination, owner isolation and soft delete.
- Project list, creation, overview and settings pages; delete with typed confirmation.
- `@qa/security` package: website URL validation against private/internal targets; safe redirects.
- Same-origin checks for state-changing API requests.
- Integration tests on a dedicated test database; HTTP smoke test script.
#### Changed
- `BETTER_AUTH_SECRET` is now required in every environment.
- Loading skeletons moved from the app-wide group to leaf routes (correct 404 status codes).

### Phase 1: Project foundation (2026-10-03)
#### Added
- npm-workspaces monorepo with `apps/web`, `apps/worker`, `packages/core`, `packages/db`.
- Environment configuration validated with zod; `.env.example`; `setup:env` secret generator.
- Structured JSON logging (pino) with secret redaction.
- Error model (`AppError`) and RFC 9457 problem+json API responses with request IDs.
- PostgreSQL connection pool, Drizzle client, real database health check, migration runner.
- `db:bootstrap` script to create the application role and databases.
- Next.js 16 application shell: responsive sidebar navigation, section pages with empty states,
  Settings page with live system status, loading/error/404 states, security headers.
- Health endpoints: `/api/v1/health`, `/api/v1/health/ready`; worker `/health` on port 3001.
- Vitest test suite (37 tests), ESLint, Prettier, TypeScript strict type checking.

### Phase 0: Architecture (2026-10-03)
#### Added
- Architecture and implementation plan (`docs/ARCHITECTURE.md`), project status tracking files.
