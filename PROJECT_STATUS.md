# Project Status: QA Copilot

_Last updated: 2026-10-03_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03.
- **Phase 2: Database + Project Management.** Approved 2026-10-03.
- **Phase 3: Dashboard / UI.** Approved 2026-10-03.

## Current phase
**Phase 4: Crawler + Playwright.** Implemented and verified. **Awaiting approval.**

## Phase 4 features implemented
- **SSRF protection at scan time** (`@qa/security`): DNS check before every request and redirect
  hop, connect-time address pinning (DNS rebinding), in-browser request guard, allowlist
  (`SCAN_ALLOWED_PRIVATE_HOSTS`).
- **Crawler** (`@qa/crawler`): URL normalization, same-site scope (www-aware), BFS with page and
  depth limits, robots.txt per RFC 9309, redirect chains (max 10), retries for transient
  failures only, 5 MB body cap, JavaScript-rendered link discovery, cancellation.
- **Technology detection**: WordPress, Shopify, Next.js, Nuxt, Gatsby, React, Vue, Angular,
  Drupal, Wix, Squarespace, PHP; server header reported separately; every result lists its
  signals and confidence; otherwise "Could not determine".
- **Browser capture** (`@qa/browser`, Playwright Chromium): per page and viewport: full-page
  screenshot (capped at 12,000 px), rendered DOM, network requests, console messages and page
  errors, navigation timings, blocked requests; mobile emulation below 768 px.
- **Storage** (`@qa/storage`): local artifacts with strict key validation; authenticated artifact
  endpoint (owner check, nosniff, sandbox CSP; HTML served as text).
- **Worker pipeline**: preflight → crawl → capture; per-step timeout; heartbeat; cancellation;
  crash recovery; scan rows as the job queue (`FOR UPDATE SKIP LOCKED`, LISTEN/NOTIFY wake-up);
  not-yet-built steps recorded as skipped with the responsible phase.
- **Web**: Start QA Scan (authorization confirmation, one active scan per project), live scan
  page via Server-Sent Events with polling fallback (steps, reasons, errors, durations, tool
  versions, technology, screenshot gallery, cancel), scans linked from history/dashboard,
  Pages tab populated by real crawl data.
- **Ops**: migration status in readiness and Settings; worker pauses scanning if migrations are
  pending; fixture website (`npm run demo:site`).

## Tests completed (2026-10-03)
- typecheck (root + 9 workspaces), ESLint, Prettier: pass.
- `vitest`: **193 passed** (19 files). New:
  - network guard incl. real sockets (rebinding blocked, allowlist), 13
  - storage key safety, 11
  - crawler: normalization, link extraction, technology detection, header redaction, and real
    crawls of the fixture (redirect chains, 404/500, robots, depth/page limits, JS-only link,
    dedupe, cancellation), 26
  - browser: real Chromium capture (DOM, PNG, console error, network sizes, mobile, blocked
    private subresource, navigation failure), 5
  - pipeline integration (real DB + fixture + Chromium): full scan (16 pages, captures ×
    3 viewports, statuses, skipped steps), page limit / robots off, unreachable site, internal
    DNS target, cancel while running, cancel while queued, crash recovery, 6
  - scan API: attestation required, ownership 404s, one active scan (409), SSE stream via real
    LISTEN/NOTIFY closing on cancel, artifact access control and path traversal, 5
- `next build`: pass. `npm run check:tsx-capture`: pass.
- **Playwright e2e: 5/5 passed**: accessibility suite (0 violations) and a full scan started from
  the UI against the fixture site, completing with live status, screenshots loading, 0 axe
  violations on the scan page, Pages tab populated.
- Problems found and fixed during verification: dev database missing the new migration (now
  detected automatically), `__name` crash of in-page scripts under tsx (scan reported the
  failure honestly; fixed), invalid `<dl>` content on the scan page.

## Known issues
- QA scanners (Phase 5), design/content comparison (6), AI (7), reports (8) are skipped steps.
- Chromium performs its own DNS resolution; the in-browser guard checks hosts before requests,
  but a DNS rebinding race inside Chromium is theoretically possible. Mitigation for production
  (egress restriction for the worker) is planned for Phase 10.
- Bare `localhost:PORT` input becomes `https://`; plain-HTTP local sites need `http://` typed.
- Scans of login-protected sites are not supported yet.
- One worker processes one scan at a time (more workers can run in parallel safely).
- Dev-tool `npm audit` findings, ESLint 9 pin and missing Docker unchanged.

## Next phase
Phase 5: the six QA scanners (accessibility, security, SEO, broken links/mixed content,
performance, responsive/visual) as independent modules with rule catalogs, structured
evidence-backed findings, timeouts, fixtures and tests.

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required); `TEST_DATABASE_URL` for integration tests;
`ENCRYPTION_KEY` in production; `SCAN_ALLOWED_PRIVATE_HOSTS` (default `localhost:4100` for the
fixture); scan limits `SCAN_*`, `LINK_CHECK_RETRIES`. See `.env.example`.
