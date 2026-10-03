# QA Copilot

AI-powered website QA, design and brand compliance platform. You provide a design reference
(Figma or brand guidelines), approved content and a website URL; QA Copilot crawls the site,
runs evidence-based QA scanners, and turns the findings into developer-ready issues and reports.

> **Status:** Phase 5 (six QA scanners). Figma/content comparison follows in Phase 6. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A full README (Docker, deployment, scanners, AI
> configuration) is completed in Phase 10.

## Requirements

- Node.js 22.12+ (npm 10+)
- PostgreSQL 15+ running locally (developed against 18)

## Local setup

```bash
npm install
npm run setup:env        # creates .env with generated local secrets (never overwrites)
npm run db:bootstrap     # creates the qa_copilot role + databases; psql asks for your postgres password
npm run db:check         # verifies the app can connect
npm run db:migrate       # creates/updates all tables (run after every pull)
npx playwright install chromium   # browser used by the scan worker
```

If migrations are pending, `/api/v1/health/ready` and the Settings page say so and the worker
pauses scan processing until `npm run db:migrate` has run.

Then open http://localhost:3000, choose **Create one** on the sign-in page and create an account.
Set `AUTH_ALLOW_SIGNUP=false` to close self-service sign-up.

`db:bootstrap` connects as the `postgres` superuser by default. Use another superuser with
`npm run db:bootstrap -- --superuser <name>`. If `psql` is not on PATH, it is looked up under
`C:\Program Files\PostgreSQL\<version>\bin`, or set `PSQL_PATH`.

## Running

```bash
npm run dev              # web (http://localhost:3000) + worker together, with reload
npm run dev:web          # web only
npm run dev:worker       # worker only
```

Production mode:

```bash
npm run build
npm run start:web
npm run start:worker
```

## Running a scan

1. Start the web app and the worker (`npm run dev`).
2. Open a project, go to **Scan**, confirm you are authorized to test the site, then **Start QA Scan**.
3. The scan page shows live progress from the worker (Server-Sent Events, polling fallback).

What a scan does: preflight (URL safety checks, reachability, robots.txt, technology detection,
site credentials) → crawl (same-site pages within the page/depth limits, redirects, HTTP status,
links rendered by JavaScript) → browser capture (every page at every viewport: screenshot,
rendered DOM, network, console, lab Core Web Vitals, layout measurements) → six QA scanners:

| Scanner | What it checks | Tooling |
|---|---|---|
| Accessibility | WCAG 2.2 A/AA + best practices per page and viewport; visible keyboard focus | axe-core |
| Security | HTTPS, HSTS, CSP, nosniff, framing, Referrer/Permissions-Policy, cookies, version disclosure, insecure forms, SRI, exposed credentials (passive only) | built-in |
| SEO | Titles, descriptions, headings, indexability, canonical, lang, viewport, alt, Open Graph, JSON-LD, duplicates, URL hygiene, robots.txt, sitemap | built-in |
| Broken links / mixed content | Every unique link (HEAD→GET, retries; confirmed vs temporary vs inconclusive), redirect chains, failed resources, mixed content | built-in |
| Performance | LCP, CLS, TBT (approx.), TTFB, FCP vs Google thresholds; page weight, JS/CSS, large/oversized images, render-blocking | Chromium performance APIs |
| Responsive / visual | Horizontal overflow, clipped text, overlapping controls, touch targets, small text, images; live mobile-menu test | built-in |

Every finding carries evidence (HTML snippet, headers, measurements, screenshots). Checks that
cannot be verified are listed as such, never reported as passes or problems. Findings are shown
on the scan page and its findings view. AI grouping, design/content comparison and reports are
shown as "skipped" with the phase that implements them.

Login-protected sites: add site credentials in project settings (HTTP Basic, a custom header or
cookies). They are encrypted with `ENCRYPTION_KEY` and sent to the scanned site only.

To try it locally, run the controlled fixture website and scan `http://localhost:4100`
(allowlisted by default in `.env.example`):

```bash
npm run demo:site
```

Scanning private or internal addresses is blocked unless the `host:port` is listed in
`SCAN_ALLOWED_PRIVATE_HOSTS`. Checks run before every request, at every redirect hop, at
connection time (DNS rebinding) and for every request made by the browser.

## Health checks

| Endpoint | Purpose |
|---|---|
| `GET http://localhost:3000/api/v1/health` | Web liveness (no dependencies) |
| `GET http://localhost:3000/api/v1/health/ready` | Config valid, PostgreSQL reachable, storage writable; 503 otherwise |
| `GET http://127.0.0.1:3001/health` | Worker status: database, scan worker state, current scan; 503 when degraded |

The **Settings** page shows the same live checks in the UI.

## API

All `/api/v1` endpoints except health checks require a session cookie (sign in via the UI or
`POST /api/auth/sign-in/email`). Errors use `application/problem+json`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/projects?q=&page=&pageSize=` | List your projects (search, pagination) |
| POST | `/api/v1/projects` | Create `{ name, websiteUrl, scanDefaults? }` |
| GET | `/api/v1/projects/:id` | Project with last scan and issue counts |
| PATCH | `/api/v1/projects/:id` | Update name, website URL, scan defaults |
| DELETE | `/api/v1/projects/:id` | Soft delete |
| POST | `/api/v1/projects/validate-url` | Check and normalize a website URL `{ websiteUrl }` |
| GET | `/api/v1/projects/:id/references` | Design references of a project |
| POST | `/api/v1/projects/:id/references` | Add a Figma link `{ figmaUrl }` (stored as pending) |
| GET | `/api/v1/dashboard/summary` | Dashboard figures computed from stored records |
| GET/PUT/DELETE | `/api/v1/projects/:id/scan-auth` | Site credentials (write-only; GET returns a summary) |
| POST | `/api/v1/projects/:id/scans` | Start a scan `{ authorizationAttested: true }` |
| GET | `/api/v1/scans/:id`, `/events` (SSE), `/captures`, `/findings` | Scan status, live events, captures, findings |
| POST | `/api/v1/scans/:id/cancel` | Cancel a queued or running scan |
| GET | `/api/v1/artifacts/:key` | Screenshot/snapshot (owner only) |

`POST /api/v1/projects` also accepts an optional `figmaUrl`, saved in the same transaction.

Website URLs are validated before they are stored: only http/https, no embedded credentials,
no private/loopback/link-local/metadata addresses or local host names, except hosts listed in
`SCAN_ALLOWED_PRIVATE_HOSTS`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                 # unit + integration tests
npm run test:unit
npm run test:integration # needs TEST_DATABASE_URL (database name must end in _test)
```

Integration tests run against `TEST_DATABASE_URL` (created by `db:bootstrap`), apply migrations
automatically and truncate tables between tests. They refuse to run against a database whose
name does not end in `_test`.

End-to-end tests (Playwright): accessibility audits (axe-core, WCAG 2.2 A/AA, desktop and 390px
mobile) and a full scan from the UI against the fixture site. They start a production web server
on port 3100, a worker (health port 3191) and the fixture site on 4100 (run `npm run build`
first; your dev servers are not touched) and remove their throwaway accounts and screenshots:

```bash
npx playwright install chromium   # once
npm run build
npm run test:e2e
```

HTTP smoke test against a running server (creates and later deletes throwaway accounts):

```bash
npm run smoke:phase2 -- create    # then restart the server
npm run smoke:phase2 -- verify    # checks data persisted, then cleans up
```

## Repository layout

```
apps/web           Next.js UI, auth, /api/v1 route handlers
apps/worker        Scan worker: claims queued scans and runs the pipeline
packages/core      Config validation, logging, error model, domain schemas
packages/db        Drizzle schema (24 tables), migrations, repositories, health check
packages/security  URL validation, DNS/connect-time SSRF guard, safe redirects
packages/crawler   HTTP fetcher, URL normalization, robots.txt, crawl loop, technology detection
packages/browser   Playwright capture with an in-browser network guard
packages/storage   Artifact storage (screenshots, HTML snapshots)
packages/scanners  The six QA scanners (contract, registry, rules)
fixtures/demo-site Controlled test website (see its README)
scripts/           Environment and database bootstrap scripts
tests/             Integration test setup, HTTP smoke tests
docs/              Architecture and design documents
```

## Configuration

All configuration comes from environment variables, documented in [.env.example](.env.example).
Both apps read the single `.env` at the repository root. Secrets are never logged or sent to the
browser; invalid configuration is reported by variable name only.
