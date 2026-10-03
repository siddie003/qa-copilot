# Project Status: QA Copilot

_Last updated: 2026-10-03_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03. Database bootstrap done by the user; `db:check` OK.

## Current phase
**Phase 2: Database + Project Management.** Implemented and verified. **Awaiting approval.**

## Phase 2 features implemented
- **Schema (Drizzle, 24 tables, migration `0000_init`)** for every entity in the architecture:
  auth (`user`, `session`, `account`, `verification`), `project`, `reference_source`,
  `design_spec`, `content_document`, `content_block`, `scan`, `scanner_run`, `page`,
  `page_capture`, `network_request`, `raw_finding`, `evidence`, `issue_track`, `issue`,
  `issue_finding`, `issue_status_event`, `grounding_check`, `ai_run`, `report`, `scan_comparison`.
  snake_case columns, 35 foreign keys, unique constraints for per-scan/per-project numbering.
- Migration runner with a Postgres advisory lock; `npm run db:migrate`.
- **Authentication (Better Auth 1.7):** email + password, 10-character minimum, hashed passwords,
  7-day database sessions in httpOnly cookies, built-in rate limits on sign-in/sign-up,
  `AUTH_ALLOW_SIGNUP` switch. Sign-in, sign-up, sign-out UI.
- **Protected routes:** `proxy.ts` redirects signed-out visitors to `/login?next=...` (safe
  redirect validation); the app layout verifies the session against the database; every
  `/api/v1` handler (except health) requires a session (401 otherwise).
- **CSRF defense in depth:** SameSite cookies plus Origin / Sec-Fetch-Site checks on writes (403).
- **Project management:** REST API (list with search and pagination, create, get, update, soft
  delete), all queries scoped to the owner (other users get 404). UI: project list, new project
  form, project overview (last scan, issue counts from DB, scan configuration), project settings
  (name, URL, scanners, viewports, crawl limits, robots.txt) and delete with typed-name confirmation.
- **Website URL validation (`@qa/security`):** http/https only, no credentials, blocks
  private/loopback/link-local/CGNAT/metadata/IPv6-local addresses (incl. hex/decimal IPv4 forms
  and IPv4-mapped IPv6) and local host names; `SCAN_ALLOWED_PRIVATE_HOSTS` allowlist.
- Dashboard shows project count with a create-project call to action (no fabricated metrics).
- Loading skeletons moved to leaf routes so missing/foreign projects return a real HTTP 404.

## Tests completed (2026-10-03)
- `npm run typecheck`: pass (root + 5 workspaces). `npm run lint`: pass. Prettier: pass.
- `vitest`: **107 passed, 0 skipped**:
  - unit: URL validation (45 cases), safe redirects, domain schemas, config, errors, logger, HTTP wrapper, storage, worker health
  - integration (real PostgreSQL, `qa_copilot_test`): projects repository (isolation, soft delete, search with literal wildcards, pagination, demo separation, counts from stored rows), Better Auth (sign-up/session/sign-out, hashed password, short/duplicate/wrong password), project API route handlers (401, CRUD, cross-user 404s, SSRF URL rejection, invalid JSON, unknown scanner, cross-origin 403, malformed id 404)
- `next build`: pass. Migration applied to the development database (24 tables).
- HTTP smoke test (`tests/smoke/phase2.mjs`) against the production build: 17/17 create checks and
  5/5 verify checks after a **server restart** (persistence confirmed), run twice; throwaway
  accounts removed.
- Browser walkthrough (production build): signed-out redirect, sign-up validation errors,
  sign-up, internal-URL rejection message, project creation, overview, settings save and
  persistence, search, delete through the dialog, sign-out and post-sign-out redirect. UI test
  account removed afterwards.

## Known issues
- Project sub-sections other than Overview and Settings (Scan, Issues, Pages, Scanner Results,
  Reports, Scan History) are not shown yet; they are added with their phases.
- No password reset or email verification (no email service configured).
- Better Auth rate limiting is in-memory (per process); fine for a single instance, revisit for
  multi-instance deployment (Phase 10).
- The guided 6-step project wizard is Phase 3; Phase 2 creates projects from name + URL.
- Dev-tooling `npm audit` findings and ESLint 9 pin unchanged from Phase 1.
- Docker not installed on this machine.

## Next phase
Phase 3: Dashboard/UI: full navigation and project sub-navigation, dashboard backed by real
data, guided project setup wizard (steps 1–6 UI, scanner selection, review), scan setup screen,
issues/reports/settings shells with empty/loading/error states, toasts, breadcrumbs.

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required). `TEST_DATABASE_URL` for integration tests.
`ENCRYPTION_KEY` required in production. `AUTH_ALLOW_SIGNUP` (default true). See `.env.example`.
