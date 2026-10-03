# Changelog

## [Unreleased]

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
