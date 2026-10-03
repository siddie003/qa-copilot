# Project Status: QA Copilot

_Last updated: 2026-10-03_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03.
- **Phase 2: Database + Project Management.** Approved 2026-10-03.

## Current phase
**Phase 3: Dashboard / UI.** Implemented and verified. **Awaiting approval.**

## Phase 3 features implemented
- **Dashboard** from stored data only: projects, total/open/reopened/in-progress/resolved issues,
  outstanding issues by severity (tiles link to filtered issue lists), scanner status of the latest
  scan, recent scans, inconclusive count. Empty states when no projects/scans exist.
- **Project area** with tabs: Overview, Scan, Issues, Pages, Scanner results, Reports, Scan history,
  Settings. Each tab runs real, owner-scoped queries and shows an explanatory empty state when
  there is no data.
  - Scan tab: readiness checklist (website, Figma reference, approved content, scanners),
    configuration summary, **Start QA Scan shown disabled** with an explanation (engine: Phase 4).
- **Global pages:** Scans (all scans), Issues (search incl. `ISSUE-<n>`, severity/status/category
  filters with categories taken from data, sorting, pagination), Reports, Settings (+ Account).
- **Guided project wizard** (6 steps): project + URL (checked live by the server), Figma link
  (validated, optional), content (honest "available in Phase 6" notice), scan configuration
  (6 scanners default on, viewports, crawl limits, robots.txt), review with edit links, create,
  then the start-scan step. Focus moves to each step heading.
- **API:** `POST /api/v1/projects/validate-url`, `GET/POST /api/v1/projects/:id/references`,
  `GET /api/v1/dashboard/summary`; project creation accepts `figmaUrl` (same transaction).
- **UI kit:** toasts (live region), breadcrumbs, pagination, severity/status/step badges (icon +
  text, never color alone), tooltips, confirmation dialog (native `<dialog>`, typed confirmation),
  stat tiles, cards.

## Tests completed (2026-10-03)
- typecheck (root + 5 workspaces), ESLint, Prettier: pass.
- `vitest`: **127 passed** (13 files). New: read-model integration tests (dashboard aggregation,
  scanner-run ordering, issue filters/search/sorting incl. literal `%`, per-page category counts,
  reports, Figma reference storage, isolation from another user), Figma URL parser (10 cases),
  Phase 3 API tests (URL check, wizard create with Figma reference, invalid Figma link creates
  nothing, references 404 for other users, dashboard per user, 401 when signed out).
- `next build`: pass.
- **Playwright + axe-core e2e (`npm run test:e2e`): 4/4 passed, 0 violations of any severity**
  (WCAG 2.2 A/AA) on 17 pages at desktop and 390px mobile, plus wizard step focus and the delete
  dialog. It first found 3 real problems (overflow from hidden tooltips, two keyboard-inaccessible
  scrollable regions), all fixed.
- Browser walkthrough on the production build: wizard end to end (internal URL and non-Figma link
  rejected, review correct), project tabs and active-tab highlighting, dashboard with real
  counts, settings save toast, delete via confirmation dialog with toast. Test accounts removed.

## Known issues
- Dashboard/scan/issue/page views have only been exercised with real empty data in the UI and with
  test-database fixtures in integration tests; they populate once scans exist (Phase 4+).
- Content upload, manual design tokens and Figma processing are Phase 6 (wizard says so).
- Authenticated (login-protected) target sites are not supported yet.
- Dev-tool `npm audit` findings, ESLint 9 pin and missing Docker unchanged.

## Next phase
Phase 4: URL validation at scan time (DNS/SSRF), crawler, URL normalization, crawl limits,
redirects, robots.txt, Playwright capture (DOM, screenshots, viewports, network, console),
technology detection, pg-boss scan pipeline in the worker, live scan status (SSE), enabling
**Start QA Scan**, tested against a controlled local fixture website.

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required); `TEST_DATABASE_URL` for integration tests;
`ENCRYPTION_KEY` in production; `AUTH_ALLOW_SIGNUP`. See `.env.example`.
