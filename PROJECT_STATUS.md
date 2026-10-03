# Project Status: QA Copilot

_Last updated: 2026-10-03_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03.
- **Phase 2: Database + Project Management.** Approved 2026-10-03.
- **Phase 3: Dashboard / UI.** Approved 2026-10-03.
- **Phase 4: Crawler + Playwright.** Approved 2026-10-03 with the instruction to fix all open
  issues; fixes delivered in commit "Fix Phase 4 open issues".

## Current phase
**Phase 5: Six QA scanners.** Implemented and verified. **Awaiting approval.**

## Phase 4 issues fixed
- DNS-rebinding gap in Chromium: closed with a local guard proxy (verified by a test where the
  route-level check is fooled but the connection is still blocked).
- Login-protected sites: site credentials (HTTP Basic, custom header, cookies), AES-256-GCM
  encrypted per project, write-only API/UI, wizard step, sent to the scanned site only (verified
  against third-party requests), clear failures for rejected/removed/undecryptable credentials.
- `localhost:PORT` input defaults to http://; HTTPS handshake failures explain the scheme.
- Worker concurrency (`WORKER_CONCURRENCY`).
- `network_request.from_cache` is NULL (unknown) instead of false.

## Phase 5 features implemented
- Scanner framework (`packages/scanners`): contract with mandatory evidence, check summaries with
  inconclusive checks, registry, re-validation before storage, per-scanner step with timeout and
  failure isolation.
- Accessibility (axe-core WCAG 2.2 A/AA + best practices on every page × viewport, merged across
  viewports; keyboard focus-visibility test; "needs review" results as inconclusive checks).
- Security (passive): HTTPS/redirect, HSTS, CSP (incl. weak sources), nosniff, framing,
  Referrer/Permissions-Policy, cookie flags, version disclosure, insecure forms, SRI, masked
  credential patterns.
- SEO: on-page metadata, headings, indexability, canonical, lang, viewport, alt, Open Graph,
  JSON-LD validity, duplicates, URL hygiene, robots.txt, sitemap existence/validity.
- Broken links / mixed content: every unique link once (reuses crawl results), HEAD→GET, retries,
  confirmed vs temporarily unavailable vs inconclusive, redirect chains, failed resources, mixed content.
- Performance: lab LCP/CLS/TBT/TTFB/FCP vs Google thresholds (worst viewport, all values in
  evidence), page weight/JS/CSS/request budgets, large and oversized images, render-blocking.
- Responsive/visual: overflow with culprit elements, clipped text, overlapping controls, touch
  targets, small text, undecodable images, live mobile-navigation test; design-based spacing is
  reported as "unable to verify" until Phase 6.
- Findings stored with display ids, evidence and fingerprints; findings view (filters, evidence,
  screenshots, unverified checks), counts on the scan page, Scanner results tab and dashboard; API.
- Performance work: full fixture scan 108 s → 38 s; redirect duplicates analyzed once.

## Tests completed (2026-10-03)
- Prettier, typecheck (root + 11 workspaces), ESLint: pass.
- `vitest`: **249 passed** (25 files), incl.:
  - scanner unit tests (26): security pass/fail matrix, CSP parsing, secret masking, SEO rules,
    duplicates, link classification matrix, performance thresholds, responsive merge, contract
  - proxy and authentication with real Chromium (rebinding blocked; Basic via real 401
    challenge; header/cookie credentials never sent to third parties)
  - encryption round trip and tamper detection; scan-auth API; findings API
  - pipeline integration on the fixture: all six scanners complete and detect every documented
    defect (27 asserted), no redirect duplicates, stored metrics; authenticated and wrong-credential
    scans; removed credentials; limits; unreachable; internal DNS; cancel; crash recovery
- `next build`: pass. `npm run check:tsx-capture`: pass.
- Playwright e2e: **5/5**: accessibility suite (0 violations) and full UI scan with all scanners
  completed, findings view with evidence and scanner filter, 0 axe violations on scan and findings pages.

## Known issues / limitations
- Findings are not yet grouped into issues; dashboard issue counts stay at 0 until Phase 7 (the
  dashboard links to the latest scan's findings instead).
- Performance metrics are single lab runs in the scanner's environment (labelled as such).
- axe-core "needs review" results and protected/blocked links are listed as unverified checks.
- Design (spacing/alignment) and content comparison: Phase 6. AI: Phase 7. Reports: Phase 8.
- Dev-tool `npm audit` findings, ESLint 9 pin, missing Docker unchanged.

## Next phase
Phase 6: Figma/brand reference processing (Figma API + manual tokens + guideline documents),
content uploads (PDF/DOCX/TXT/MD) and extraction, design-token and content comparison against the
website (match / confirmed mismatch / potential / unable to verify).

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required); `ENCRYPTION_KEY` (required to store site
credentials; required in production); `TEST_DATABASE_URL` for integration tests;
`SCAN_ALLOWED_PRIVATE_HOSTS`, `SCAN_*`, `LINK_CHECK_RETRIES`, `WORKER_CONCURRENCY`. See `.env.example`.
