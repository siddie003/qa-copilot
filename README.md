# QA Copilot

AI-powered website QA, design and brand compliance platform. You provide a design reference
(Figma or brand guidelines), approved content and a website URL; QA Copilot crawls the site,
runs evidence-based QA scanners, and turns the findings into developer-ready issues and reports.

> **Status:** Phase 8 (issue management + reporting). Scan history and comparison follow in Phase 9. See [PROJECT_STATUS.md](PROJECT_STATUS.md) and
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

After the scanners, two reference comparisons run when the project has references:

| Comparison | Compares | Verdicts |
|---|---|---|
| Design | The confirmed design reference (typography, colors with roles, buttons, container width) with computed styles of the mapped elements (explicit CSS selector > semantic HTML > class-name heuristics); colors by CIEDE2000 ΔE (≤ 2 match, 2–5 needs review, > 5 differs), sizes ±0.5px | match · confirmed mismatch · potential mismatch · unable to verify |
| Content | Approved content blocks with the visible text of the mapped page (page mapping > “Page:/URL:” marker > page name > heading similarity); exact, changed wording (≥ 0.85 similarity, word diff), rewritten, missing, capitalization, CTA text and link target | match · confirmed mismatch · potential mismatch · unable to verify |

Every finding carries evidence (HTML snippet, headers, measurements, screenshots, computed styles,
word diffs with document citations). Checks that cannot be verified are listed as such, never
reported as passes or problems. Findings are shown on the scan page and its findings view; every
compared reference value (matches included) is listed on the scan's **comparison** page. Then the
findings become issues (next section), which you can work on and export as reports.

## Issues and AI analysis

After the scanners, two more steps turn findings into developer-ready issues:

1. **AI analysis** (only when an AI provider is configured): the findings are grouped
   deterministically — one issue per scanner rule (e.g. "Meta description is missing (4 pages)"),
   one per design value or approved text block — and the provider writes a title, description,
   severity rationale, fix steps and cited statements for each group, in batches per category.
2. **Evidence validation** (always): a deterministic grounding validator checks the AI text against
   the evidence. AI text that cites findings that do not exist or belong to another issue is
   rejected; any field containing a number, color, URL, page path, quote or finding id that is not
   in the issue's evidence is replaced with the scanner's own wording; severity may move at most
   one level (never up for unconfirmed findings); affected pages, category and the findings of an
   issue never come from AI. Every check is stored and shown with the issue.

Without a provider (`AI_PROVIDER=none`) or when a request fails, issues use the scanners' wording
and the rule catalog's fix guidance — nothing is lost, and raw findings are never changed. Each
finding belongs to exactly one issue; issues keep a stable `ISSUE-n` number across scans. The
scan's **Issues** page shows every issue with its source findings, how its text was produced
("AI text, evidence-checked", "AI text, parts replaced", "AI text rejected", "Scanner wording"),
each grounding check and the AI requests made (tokens, model; prompts are not stored).

AI configuration (see `.env.example`): `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` and
`AI_MODEL` (recommended `claude-opus-5-5`), optional `AI_EFFORT`; refusals by Anthropic's safety
classifiers are retried on the recommended fallback model (`AI_REFUSAL_FALLBACK=true`). Or
`AI_PROVIDER=openai-compatible` with `OPENAI_API_KEY`, `AI_MODEL` and optional `OPENAI_BASE_URL`
for any Chat Completions server that supports JSON-schema output. `AI_CONCURRENCY`,
`AI_TIMEOUT_MS` and `AI_MAX_OUTPUT_TOKENS` tune requests. The AI receives finding data only (never
credentials); website content is passed as escaped data that it is told not to follow.

## Working on issues

The **Issues** page (all projects) and each project's **Issues** tab list tracked issues with
filters for severity, status, verdict (confirmed, needs review, unable to verify), scanner,
affected page URL, confidence and when the issue was last detected, plus search by title or
`ISSUE-n` and sorting. Select issues to change their status in bulk.

Each issue has a detail page (`/projects/:id/issues/:n`) with the description, affected pages,
expected/actual values, fix guidance, every source finding with its evidence, the grounding checks
behind its text, every scan it was found in (older occurrences can be opened), and its **status
history**. Users set *Open*, *In progress*, *Resolved* or *Ignored* (with an optional note);
*Inconclusive* (evidence cannot confirm the issue) and *Reopened* are set by the system only.
Every change is recorded with who made it, when, the note and the previous status; detections
and evidence-based status changes made by scans are recorded as system events with the scan.

## Reports

Reports are generated on demand from a **finished** scan (project **Reports** tab, or the
**Reports** button on a scan): **PDF** (for sharing), **Markdown** (tickets, pull requests, wikis)
or **JSON** (versioned schema `qa-copilot-report` v1, including every finding's evidence). The
worker builds them only from stored records: scan settings, every pipeline step with its result
(failed, inconclusive and skipped steps with their reasons), checks that could not be verified,
and every issue with its tracking status at generation time, verdict, fix guidance and source
findings. Website text is escaped in every format; the PDF is rendered by Chromium with JavaScript
disabled and all network requests blocked. Files are stored under `reports/` in `STORAGE_DIR` and
downloaded through an owner-checked endpoint.

## Design references and approved content

Open a project's **References** tab (or use the setup wizard):

- **Figma**: add a file or frame link. With a Figma personal access token (`FIGMA_ACCESS_TOKEN`
  or a per-project token saved encrypted on the References page), the worker reads local text
  styles, color styles, Button components (Primary/Secondary variants) and a frame named
  “Container”. Every value records the Figma node it came from.
- **Brand guideline** (PDF, DOCX, TXT, Markdown): values written literally (e.g.
  “Primary — #1A56DB”, “H1 — Georgia Bold, 48px / 56px”) are extracted with page/line citations.
- **Manual values / JSON**: the token editor, with JSON import and export.

With an AI provider configured, guideline documents are also read with AI assistance: values
written in prose ("Our body copy is set in Inter Regular at 16px") are added only if they appear
in the line they cite, only where the literal reading found nothing, and are marked "read with AI
assistance" in their citation.

Extracted values (Figma, guideline) become a **draft**: review each change with its source, then
confirm or discard it. Manually entered values are never overwritten by extraction. Scans use the
newest confirmed version; each scan records the version it used.

**Approved content** documents (PDF, DOCX, TXT, Markdown, up to `MAX_UPLOAD_MB`) are validated
(extension, type, content, zip-bomb guard), stored under random keys and parsed by the worker into
blocks (headings, paragraphs, list items, links, CTAs). Map a document to a page (e.g. `/about`),
or use markers inside it: a line `Page: About`, `URL: /about` or `<!-- page: /about -->` applies
to the following blocks; `CTA: Text → /path` or `CTA: [Text](/path)` declares a call to action.
Scanned (image-only) PDFs are reported as unreadable (no OCR).

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
| POST | `/api/v1/projects/:id/references` | Add a Figma link `{ figmaUrl }` (queued for the worker) |
| POST/DELETE | `/api/v1/projects/:id/references/:refId/refresh`, `/references/:refId` | Fetch/extract again, remove |
| GET/PUT | `/api/v1/projects/:id/design-spec` | Active spec, draft (with changes) and history; save values as a new confirmed version |
| POST/DELETE | `/api/v1/projects/:id/design-spec/draft/confirm` `{ version }`, `/design-spec/draft` | Confirm or discard the pending draft |
| POST | `/api/v1/projects/:id/guideline-documents` | Upload a brand guideline (multipart `file`) |
| GET/POST | `/api/v1/projects/:id/content-documents` | List or upload content documents (multipart `file`, optional `targetPath`) |
| PATCH/DELETE | `/api/v1/content-documents/:id` | Set the page mapping `{ targetPath }`, delete |
| GET/POST | `/api/v1/content-documents/:id/blocks`, `/retry` | Extracted blocks; retry a failed document |
| PUT/DELETE | `/api/v1/projects/:id/figma-token` | Store (encrypted, write-only) or remove the project's Figma token |
| GET | `/api/v1/dashboard/summary` | Dashboard figures computed from stored records |
| GET/PUT/DELETE | `/api/v1/projects/:id/scan-auth` | Site credentials (write-only; GET returns a summary) |
| POST | `/api/v1/projects/:id/scans` | Start a scan `{ authorizationAttested: true }` |
| GET | `/api/v1/scans/:id`, `/events` (SSE), `/captures`, `/findings` | Scan status, live events, captures, findings |
| GET | `/api/v1/scans/:id/issues?grounding=` | Issues of a scan with source findings, grounding checks and AI requests |
| GET | `/api/v1/issues`, `/api/v1/projects/:id/issues` | Tracked issues; filters `severity`, `status`, `verdict` (confirmed/potential/unverified), `category`, `url`, `minConfidence` (0–100), `since` (1d/7d/30d/90d), `q`, `sort`, `page`, `pageSize`, `projectId` |
| GET | `/api/v1/issues/:id?scanId=` | Issue detail: occurrences, selected occurrence with findings, evidence and grounding checks, status history |
| PATCH | `/api/v1/issues/:id/status` | Set the status `{ status: open|in_progress|resolved|ignored, note? }` (audited) |
| POST | `/api/v1/issues/status` | Bulk status change `{ ids (≤ 100), status, note? }` (all or nothing) |
| GET/POST | `/api/v1/scans/:id/reports` | List a scan's reports; request one `{ format: pdf|md|json }` (202, finished scans only) |
| GET/DELETE | `/api/v1/reports/:id` | Report status (`downloadUrl` when ready); delete report and file |
| GET | `/api/v1/reports/:id/download` | Download a completed report (attachment) |
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
mobile), a full scan from the UI against the fixture site, references and comparison, and the
issue workflow with report generation and downloads. They start a production web server
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
apps/worker        Scan worker (claims queued scans, runs the pipeline), reference worker
                   (parses documents, reads Figma, extracts guideline drafts) and report worker
packages/core      Config validation, logging, error model, domain schemas
packages/db        Drizzle schema (24 tables), migrations, repositories, health check
packages/security  URL validation, DNS/connect-time SSRF guard, safe redirects
packages/crawler   HTTP fetcher, URL normalization, robots.txt, crawl loop, technology detection
packages/browser   Playwright capture with an in-browser network guard
packages/storage   Artifact storage (screenshots, HTML snapshots, uploads, reports)
packages/reports   Report data model (JSON schema v1), Markdown and HTML (PDF) renderers
packages/scanners  The six QA scanners plus design and content comparison
packages/reference Document extraction (PDF/DOCX/TXT/MD), Figma client + normalizer, guideline extraction
packages/ai        AI providers (Anthropic, OpenAI-compatible, none), issue grouping, rule catalog,
                   grounding validator, AI-assisted guideline reading
fixtures/demo-site Controlled test website (see its README)
fixtures/documents Design spec + approved content for the fixture; real DOCX/PDF builders
fixtures/figma     Figma REST response used by tests
scripts/           Environment and database bootstrap scripts
tests/             Integration test setup, HTTP smoke tests
docs/              Architecture and design documents
```

## Configuration

All configuration comes from environment variables, documented in [.env.example](.env.example).
Both apps read the single `.env` at the repository root. Secrets are never logged or sent to the
browser; invalid configuration is reported by variable name only.
