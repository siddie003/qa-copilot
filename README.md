# QA Copilot

AI-powered website QA, design and brand compliance platform. You provide a design reference
(Figma or brand guidelines), approved content and a website URL; QA Copilot crawls the site,
runs evidence-based QA scanners, and turns the findings into developer-ready issues and reports.

> **Status:** Phase 10 (production hardening) complete — all planned phases are implemented. See
> [PROJECT_STATUS.md](PROJECT_STATUS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and, for
> production, [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
> An enhancement programme (Phases 11–16: free-tier LLM, large documents, Figma multi-page
> processing, UX) started on 2026-10-09; its baseline and plan are in
> [ENHANCEMENT_BASELINE.md](ENHANCEMENT_BASELINE.md).

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
npm run db:migrate
npm run start:web
npm run start:worker
```

For a real deployment (HTTPS reverse proxy, production settings, Docker Compose, backups,
upgrades, security checklist) follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The `Dockerfile`
and `docker-compose.yml` are provided but were not verified (Docker was not available while they
were written).

## Running a scan

1. Start the web app and the worker (`npm run dev`).
2. Open a project, go to **Scan**, confirm you are authorized to test the site, then **Start QA Scan**.
3. The scan page shows live progress from the worker (Server-Sent Events, polling fallback).

What a scan does: preflight (URL safety checks, reachability, robots.txt, technology detection,
site credentials) → crawl (same-site pages within the page/depth limits, redirects, HTTP status,
links rendered by JavaScript, plus the project's **page links**, which are always visited and
marked “Your page link”; one that cannot be loaded is reported with its error) → browser capture
(every page at every viewport: screenshot, rendered DOM, network, console, lab Core Web Vitals,
layout measurements) → the selected QA scanners:

| Scanner | What it checks | Tooling |
|---|---|---|
| Accessibility | WCAG 2.2 A/AA + best practices per page and viewport; visible keyboard focus | axe-core |
| Security | HTTPS, HSTS, CSP, nosniff, framing, Referrer/Permissions-Policy, cookies, version disclosure, insecure forms, SRI, exposed credentials (passive only) | built-in |
| SEO | Titles, descriptions, headings, indexability, canonical, lang, viewport, alt, Open Graph, JSON-LD, duplicates, URL hygiene, robots.txt, sitemap | built-in |
| Broken links / mixed content | Every unique link (HEAD→GET, retries; confirmed vs temporary vs inconclusive), redirect chains, failed resources, mixed content | built-in |
| Performance | LCP, CLS, TBT (approx.), TTFB, FCP vs Google thresholds; page weight, JS/CSS, large/oversized images, render-blocking | Chromium performance APIs |
| Responsive / visual | Horizontal overflow, clipped text, overlapping controls, touch targets, small text, images; live mobile-menu test | built-in |
| Design Quality & Typography | H1–H6 typography per level and screen size (consistency, visual hierarchy), web fonts that did not render, text not in the uploaded brand fonts, images enlarged beyond their source or stretched, spacing against the reference spacing scale, near-miss alignment, uneven gaps; reports the design and content comparisons' results for headings and approved text by cross-reference (no duplicate findings) | computed styles, Chromium font engine (DevTools `CSS.getPlatformFontsForNode`), DOM geometry |

After the scanners, two reference comparisons run when the project has references (Design
Quality & Typography runs after them, because it reports their outcome):

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
   severity rationale, fix steps, cited statements and an optional plain-language explanation
   (problem, impact, next step, steps, caveats) for each group, in batches per category.
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

AI configuration: see **[LLM_PROVIDER_SETUP.md](LLM_PROVIDER_SETUP.md)** (verified free-tier
limits, data-use terms, setup, troubleshooting). Providers: `gemini` (Google Gemini API free tier,
`GEMINI_API_KEY`, e.g. `AI_MODEL=gemini-3.8-flash`), `groq` (`GROQ_API_KEY`, e.g.
`openai/gpt-oss-120b`), `anthropic` (`ANTHROPIC_API_KEY`, recommended `claude-opus-5-5`, optional
`AI_EFFORT`, refusal fallback with `AI_REFUSAL_FALLBACK=true`) and `openai-compatible`
(`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`). Free-tier controls: `AI_REQUESTS_PER_MINUTE`,
`AI_TOKENS_PER_MINUTE`, `AI_MAX_INPUT_TOKENS`, `AI_MAX_ISSUES_PER_SCAN`, `AI_MAX_RETRIES`,
`AI_MAX_RETRY_WAIT_MS`, `AI_STRUCTURED_OUTPUT`. Rate limits are retried with jittered backoff and
`Retry-After`; exhausted quotas and credential errors stop further requests of the scan (its
issues keep the scanners' wording). Check a configuration with `npm run ai:check` (one request).
The AI receives finding data only (never credentials; credential-shaped strings are removed);
website content is passed as escaped data that it is told not to follow.

## Working on issues

The **Issues** page (all projects) and each project's **Issues** tab list tracked issues with
filters for severity, status, verdict (confirmed, needs review, unable to verify), scanner,
affected page URL, confidence and when the issue was last detected, plus search by title or
`ISSUE-n` and sorting. Select issues to change their status in bulk.

Each issue has a detail page (`/projects/:id/issues/:n`) in two levels. **Level 1** explains
the issue for developers and non-developers alike: **In plain language** (What is the problem? Why
does it matter? What should I do next? How serious?), **Where it was found** (pages, screen sizes,
element, the HTML the scanner recorded and the measured values), **How to fix it** (numbered
steps, things to watch out for, and what the scan could not tell), **Example fix** (before/after
code with a copy button, only where the evidence supports one) and **How to verify the fix**.
The wording per rule is fixed text (`packages/core/src/explain.ts`, `packages/core/src/fix-guide.ts`)
filled in only with the scan's own records: "before" code is copied from the evidence or labelled
illustrative, anything the scan cannot know (what an image shows, the page language, the right
link) is a `[placeholder]`, and a suggested fix is never shown as verified — only a later scan
that re-checks the same pages confirms it. When AI is configured, grounded AI text may replace the
summary, steps or caveats (labelled; code examples are never AI-written). **Level 2**, the
collapsible **Technical details and evidence** section, keeps the description, rule id, all
affected pages, expected/actual values, the stored recommendation, how reliable the finding is,
every source finding with its raw evidence and screenshots, and the grounding checks behind its
text. The sidebar shows every scan the issue was found in (older occurrences can be opened) and its
**status history**. The scan's **Findings** page shows the same guide for every raw finding
(built when the finding is opened), with the scanner's own output under "Technical details and
evidence". Users set *Open*, *In progress*, *Resolved* or *Ignored* (with an optional note);
*Inconclusive* (evidence cannot confirm the issue) and *Reopened* are set by the system only.
Every change is recorded with who made it, when, the note and the previous status; detections
and evidence-based status changes made by scans are recorded as system events with the scan.

**Reopen rule:** when a scan finds an issue again that a user marked *Resolved* before that scan
started, its status becomes *Reopened* (system event "Found again by this scan after it was marked
resolved."). An occurrence that is only *unable to verify* does not reopen it, and a fix claimed
while the scan was already running is not overruled by that scan. *In progress* and *Ignored* are
kept. Scans never set an issue to *Resolved* on their own; the comparison page offers to confirm
fixes it found (an audited bulk change).

## Scan history and comparison

The project's **Scan history** tab shows the latest changes (the newest scan compared with the
previous one), a chart of issues per scan by severity (each bar opens that scan's comparison),
a scan picker, and every scan with its issue counts (needs review, unable to verify) and its
changes compared with the previous comparable scan. A comparable scan is a finished scan whose
evidence-validation step created issue records; scans without them (failed early, cancelled, or
run before issue tracking) are listed with the reason and skipped. Finished scans also have a
**Compare with scan #n** button, and the dashboard shows the latest changes of recent scans.

**Compare two scans** (`/projects/:id/history/compare?base=&target=`) classifies every tracked
issue of either scan, computed only from the stored records of the two scans:

| Category | Meaning |
|---|---|
| New | In the target scan only; the base scan checked the same pages with the same scanner |
| Reopened | Marked resolved and found again by the target scan, or seen in an earlier scan, absent from the base scan and found again |
| Changed | In both, with a different severity or verdict, findings no longer found or new findings, or different observed values |
| Resolved | In the base scan only, and the target scan re-checked every one of its findings |
| Persistent | In both with the same severity, verdict and findings |
| Not rechecked | In the base scan only, but the target scan could not re-check it — never counted as resolved |
| Newly checked | In the target scan only, but the base scan could not have seen it — never counted as new |

"Re-checked" means: the scanner ran (completed or inconclusive, not failed/skipped/not selected),
the page was crawled and analyzable (no error, HTTP < 400, HTML), the finding's viewport was
captured without error, the scanner did not report that page (or that rule on the page) as
unverifiable, a scanner-wide limit was not hit (link-check limit), and for design/content issues
the design reference / approved content did not change. The reason is shown for every issue and,
inside it, for every finding (matched by fingerprint: new, no longer found, changed values,
unchanged, not rechecked, newly checked). Performance values are lab measurements that vary
between page loads: a different measured value or worst viewport is shown but is not counted as a
change; crossing a threshold (a different severity) is. The page also lists scanner and step status changes
(now completes / no longer completes / other changes) and warnings about different settings
(website URL, scanners, viewports, crawl limits, references, scans that completed with failures).
Comparing a scan without issue records still compares the steps and says why issues cannot be
compared. Summaries are cached in `scan_comparison` (recomputed when the rules change).

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

The setup wizard collects everything in five steps: **Project** (name, website URL, optional
brand guidelines and font files) → **Figma / brand** (Figma design URL, design values by hand,
content documents with optional page mapping, page links with “+ Add page”) → **Configure scan**
→ **Review** → **Start scan** (files are uploaded after the project is created, with progress and
a Retry button for failures). Only the name and website URL are required.

Open a project's **References** tab to manage the same inputs later:

- **Figma**: add a file or frame link. With a Figma personal access token (`FIGMA_ACCESS_TOKEN`
  or a per-project token saved encrypted on the References page), the worker reads local text
  styles, color styles, Button components (Primary/Secondary variants) and a frame named
  “Container”. Every value records the Figma node it came from. Large files are read page by
  page (any number of pages) with a manifest of every page and frame, Figma's rate limits are
  respected (a stopped read is shown as Partial and can continue with only the missing pages),
  and unchanged files are not fetched again; see **[FIGMA_INTEGRATION.md](FIGMA_INTEGRATION.md)**.
- **Brand guideline** (PDF, DOCX, TXT, Markdown): values written literally (e.g.
  “Primary — #1A56DB”, “H1 — Georgia Bold, 48px / 56px”) are extracted with page/line citations.
- **Manual values / JSON**: the token editor, with JSON import and export.
- **Brand fonts** (WOFF2, WOFF, TTF, OTF, up to 10 MB each, 20 per project): the file is
  accepted only if its font tables can be read; family, style, weight, italic and the licence's
  embedding bits are read from the file itself. Fonts are stored privately and never added to the
  website; the Design Quality scanner checks whether headings and text use them and whether
  Chromium actually renders them. Collections (.ttc) are not supported.
- **Page links**: pages of the website that every scan must include (same site only, validated
  against the SSRF rules, duplicates rejected). They are scanned outside the page and depth
  limits. They are not mapped to Figma frames: the design reference is a set of values, not page
  layouts.

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
Large documents are processed in persisted batches (PDFs page by page) with real progress, a
coverage report (pages with text, blank, image-only — no OCR — and failed), cancel and "Continue
reading" after an interruption, and a full-text index of sections that can be searched on the
References page; see **[LARGE_DOCUMENT_PROCESSING.md](LARGE_DOCUMENT_PROCESSING.md)**. Image-only
(scanned) pages are listed as not read, never silently skipped.

Login-protected sites: add site credentials in project settings (HTTP Basic, a custom header or
cookies). They are encrypted with `ENCRYPTION_KEY` and sent to the scanned site only.

For a complete, guided demo (brand guidelines, fonts, approved content, page links, real
defects, a fix-and-rescan), see **[fixtures/manager-demo/DATA_MANIFEST.md](fixtures/manager-demo/DATA_MANIFEST.md)**
and `npm run demo:manager`.

To try it locally, run the controlled fixture website and scan `http://localhost:4100`
(allowlisted by default in `.env.example`):

```bash
npm run demo:site
```

To try a comparison, the fixture has a second version (`v2`: some defects fixed, one added, one
page failing). Scan, then switch with `curl -X POST --data v2 http://localhost:4100/__fixture/variant`
(or start it with `node fixtures/demo-site/server.mjs 4100 v2`) and scan again. A project can also
request a version with a custom-header site credential `X-Fixture-Variant: v2`.

Scanning private or internal addresses is blocked unless the `host:port` is listed in
`SCAN_ALLOWED_PRIVATE_HOSTS`. Checks run before every request, at every redirect hop, at
connection time (DNS rebinding) and for every request made by the browser.

## Security

- **Accounts:** email + password (Better Auth, hashed passwords, database sessions, httpOnly
  SameSite cookies, Secure on HTTPS). Sign-in is limited per IP (Better Auth) and, independent of
  the IP, per account: 10 failed attempts in 15 minutes lock the account's sign-in for the rest
  of that window. Set `AUTH_ALLOW_SIGNUP=false` to close sign-up.
- **Authorization:** every query is scoped to the signed-in owner; another user's projects,
  scans, issues, reports, documents, references and files answer 404 (tested route by route).
  State-changing requests must come from the app's own origin.
- **Rate limits (per user):** 600 API requests/min; 20 scan starts/hour; 30 uploads, 30 report
  requests and 30 design-reference requests per 10 min; 30 new projects/hour (429 with
  `Retry-After`; `RATE_LIMIT_ENABLED`). One queued or running scan per project (database
  constraint).
- **Browser protections:** nonce-based Content-Security-Policy on every page (no inline or
  third-party scripts), HSTS on HTTPS, `X-Frame-Options: DENY`, `nosniff`, strict referrer and
  permissions policies; scanned website content is always rendered as text. Stored files
  (screenshots, page snapshots, report downloads) are served with their own
  `default-src 'none'; sandbox; frame-ancestors 'none'` policy, and HTML snapshots as plain text.
- **Scanning safety (SSRF):** only http/https; private, loopback, link-local, CGNAT, metadata and
  other reserved addresses are refused when a URL is saved, before every request and redirect, at
  connection time and for every request Chromium makes (guard proxy); `SCAN_ALLOWED_PRIVATE_HOSTS`
  is the explicit exception list. Chromium never saves downloads.
- **Uploads:** extension, declared type and file content must agree; DOCX archives are checked
  for zip bombs, including archives that understate their content (every entry is decompressed
  and measured before parsing); documents are parsed in a separate worker thread with a memory
  and time limit; files are stored under random names and served only through owner-checked
  endpoints.
- **Secrets:** site credentials and Figma tokens are encrypted (AES-256-GCM, `ENCRYPTION_KEY`),
  write-only in the API and deleted with their project; logs redact secrets and never contain
  bound database query parameters; error responses never contain internals.

## Health checks

| Endpoint | Purpose |
|---|---|
| `GET http://localhost:3000/api/v1/health` | Web liveness (no dependencies) |
| `GET http://localhost:3000/api/v1/health/ready` | Config valid, PostgreSQL reachable, storage writable; 503 otherwise |
| `GET http://127.0.0.1:3001/health` | Worker status: database, scan worker state, current scan; 503 when degraded |

The **Settings** page shows the same live checks in the UI and, in production, warnings about
risky settings (also logged when each process starts).

## Maintenance

```bash
npm run db:migrate                 # after every pull/upgrade (the worker pauses until it ran)
npm run storage:gc                 # dry run: stored files that no record references any more
npm run storage:gc -- --apply      # remove them (only files older than 24 h)
```

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
| POST/DELETE | `/api/v1/projects/:id/references/:refId/refresh`, `/references/:refId` | Fetch/extract again (or continue a stopped read), remove |
| POST | `/api/v1/projects/:id/references/:refId/cancel` | Cancel a queued or running reference read |
| GET/PUT | `/api/v1/projects/:id/design-spec` | Active spec, draft (with changes) and history; save values as a new confirmed version |
| POST/DELETE | `/api/v1/projects/:id/design-spec/draft/confirm` `{ version }`, `/design-spec/draft` | Confirm or discard the pending draft |
| POST | `/api/v1/projects/:id/guideline-documents` | Upload a brand guideline (multipart `file`; the same file twice → 409) |
| GET/POST | `/api/v1/projects/:id/fonts` | List or upload brand font files (multipart `file`; validated and read before storing; the same file twice → 409) |
| DELETE | `/api/v1/projects/:id/fonts/:fontId` | Remove a brand font file |
| GET/POST | `/api/v1/projects/:id/page-links` | List or add a page link `{ url }` (full URL or `/path`; same site; duplicate → 409) |
| DELETE | `/api/v1/projects/:id/page-links/:linkId` | Remove a page link |
| GET/POST | `/api/v1/projects/:id/content-documents` | List or upload content documents (multipart `file`, optional `targetPath`) |
| PATCH/DELETE | `/api/v1/content-documents/:id` | Set the page mapping `{ targetPath }`, delete |
| GET/POST | `/api/v1/content-documents/:id/blocks`, `/retry`, `/cancel` | Extracted blocks; retry or continue a document; cancel processing |
| GET | `/api/v1/projects/:id/content-search?q=&document=` | Full-text search of indexed approved content |
| PUT/DELETE | `/api/v1/projects/:id/figma-token` | Store (encrypted, write-only) or remove the project's Figma token |
| GET | `/api/v1/dashboard/summary` | Dashboard figures computed from stored records |
| GET/PUT/DELETE | `/api/v1/projects/:id/scan-auth` | Site credentials (write-only; GET returns a summary) |
| POST | `/api/v1/projects/:id/scans` | Start a scan `{ authorizationAttested: true }` |
| GET | `/api/v1/scans/:id`, `/events` (SSE), `/captures`, `/findings` | Scan status, live events, captures, findings |
| GET | `/api/v1/scans/:id/issues?grounding=` | Issues of a scan with source findings, grounding checks and AI requests |
| GET | `/api/v1/issues`, `/api/v1/projects/:id/issues` | Tracked issues; filters `severity`, `status`, `verdict` (confirmed/potential/unverified), `category`, `url`, `minConfidence` (0–100), `since` (1d/7d/30d/90d), `q`, `sort`, `page`, `pageSize`, `projectId` |
| GET | `/api/v1/projects/:id/comparisons?base=&target=` | Comparison of two finished scans (defaults: latest comparable scan and the one before it); 400 reversed/same scan, 404 foreign scans, 409 unfinished or nothing to compare |
| GET | `/api/v1/projects/:id/history?page=&pageSize=` | Scan history with issue counts, changes vs the previous comparable scan and the trend |
| GET | `/api/v1/issues/:id?scanId=` | Issue detail: occurrences, selected occurrence with findings, evidence and grounding checks, status history |
| PATCH | `/api/v1/issues/:id/status` | Set the status `{ status: open|in_progress|resolved|ignored, note? }` (audited) |
| POST | `/api/v1/issues/status` | Bulk status change `{ ids (≤ 100), status, note? }` (all or nothing) |
| GET/POST | `/api/v1/scans/:id/reports` | List a scan's reports; request one `{ format: pdf|md|json }` (202, finished scans only) |
| GET/DELETE | `/api/v1/reports/:id` | Report status (`downloadUrl` when ready); delete report and file |
| GET | `/api/v1/reports/:id/download` | Download a completed report (attachment) |
| POST | `/api/v1/scans/:id/cancel` | Cancel a queued or running scan |
| GET | `/api/v1/artifacts/:key` | Screenshot/snapshot (owner only) |

`POST /api/v1/projects` also accepts an optional `figmaUrl` and `pageLinks` (array of URLs or
paths), saved in the same transaction; an invalid page link rejects the whole request (400, error
path `pageLinks.<n>`) so nothing is created. Uploading the same content document twice to a
project is refused (409).

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
mobile), a full scan from the UI against the fixture site, references and comparison, the
issue workflow with report generation and downloads, scan history with a comparison of two
real scans of the fixture's v1 and v2, and the Phase 10 acceptance workflow (sign-up → project →
approved content → scan → issue status → report download → rescan → comparison → project
deletion, with the Content-Security-Policy checked on every page). They start a production web server
on port 3100, a worker (health port 3191) and the fixture site on 4100 (run `npm run build`
first; your dev servers are not touched) and remove their throwaway accounts and screenshots:

```bash
npx playwright install chromium   # once
npm run build
npm run test:e2e
```

Full smoke test of a running installation (web on :3000, worker on :3001, fixture site on
:4100; about 1–2 minutes). It checks health and readiness, sign-up and protected routes, then
scans the fixture's v1 and v2 with all six scanners and checks findings, evidence, issues, a JSON
report, the scan history and the comparison. It ends with `SMOKE TEST PASSED` (exit code 0) and
deletes its throwaway account (`-- --keep` keeps it):

```bash
npm run smoke
```

Phase 2 persistence smoke test (creates and later deletes throwaway accounts):

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
packages/db        Drizzle schema (25 tables), migrations, repositories, health check
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
docs/              Architecture (ARCHITECTURE.md) and deployment (DEPLOYMENT.md)
Dockerfile, docker-compose.yml, deploy.env.example   Container build and Compose stack (unverified)
```

## Configuration

All configuration comes from environment variables, documented in [.env.example](.env.example).
Both apps read the single `.env` at the repository root. Secrets are never logged or sent to the
browser; invalid configuration is reported by variable name only.
