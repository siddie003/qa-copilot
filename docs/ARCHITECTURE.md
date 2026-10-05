# QA Copilot — Phase 0 Architecture & Implementation Plan

Status: **Draft for approval** · Date: 2026-10-03 · Phase: 0 (no functional code yet)

---

## 0. Repository & environment inspection

| Item | Finding |
|---|---|
| Repository | Empty workspace, not a Git repo → initialize a new monorepo |
| Node.js | v22.16.0 (LTS) ✓ |
| npm | 10.9.2 ✓ (pnpm not installed → use **npm workspaces**) |
| Python | 3.13 (not needed by the chosen stack) |
| Git | 2.50 ✓ |
| PostgreSQL | **18.6 installed as Windows service, accepting connections on localhost:5432** ✓ (`psql` not on PATH; at `C:\Program Files\PostgreSQL\18\bin`) |
| Redis | Not installed → design avoids Redis (Postgres-backed job queue) |
| Docker | **Not installed** → Dockerfiles/compose will be written but cannot be verified locally unless Docker Desktop is installed |
| RAM / disk | 15.4 GB / 135 GB free — sufficient for Playwright Chromium + Lighthouse |
| OS | Windows 11 — all tooling chosen is Windows-compatible; paths handled with `node:path` |

---

> **Amendments during implementation**
> - Phase 6: `packages/reference` holds document extraction (PDF via unpdf with font-size heading
>   recovery, DOCX via mammoth, Markdown via mdast, TXT), the Figma REST client/normalizer and the
>   guideline extractor. Guideline extraction is **deterministic** (only literal values, cited by
>   page/line); AI-assisted extraction can be added in Phase 7. Figma and guideline results become
>   **drafts** that the user confirms; manual values are never overwritten by extraction. Parsing
>   and Figma reads run in a separate **reference worker loop** in `apps/worker` (content
>   documents and reference sources are the jobs, claimed with SKIP LOCKED; LISTEN
>   `reference_queued`), never in the web process. Capture collects computed styles of design roles
>   (`page_capture.computed_styles_key`, all viewports) and visible text (`text_content_key`, widest
>   viewport) only when the scan has references. Design/content comparisons are steps after the six
>   scanners; without references they are created as `skipped` with an "unable to verify" reason.
>   Every compared value (matches included) is stored in `scanner_run.checks.comparison`; only
>   mismatches become findings. Content markers: `Page:`/`URL:` lines and `<!-- page: -->`
>   comments; `CTA:` lines. Visual (pixel) diff against Figma frames was not implemented.
> - Phase 5: scanners live in `packages/scanners`, consume stored crawl/capture data through a
>   read-only `ScannerContext` (plus `openPage` for live checks: axe, keyboard focus, mobile menu)
>   and return validated findings (zod, evidence required). Lab Core Web Vitals and layout metrics
>   are collected once during capture. Redirecting URLs that reach an already-analyzed document are
>   analyzed once. Lighthouse was not used: the same lab metrics come from Chromium's
>   PerformanceObserver APIs without a second browser.
> - Phase 4 fixes: Chromium traffic goes through a local guard proxy (no DNS in Chromium); site
>   credentials (Basic/header/cookies) encrypted per project in `project_secret`.
> - Phase 4: **no pg-boss.** The `scan` row is the durable job: the web app inserts it as
>   `queued` and NOTIFYs `scan_queued`; workers claim rows with `UPDATE ... FOR UPDATE SKIP LOCKED`,
>   send heartbeats, honor `cancel_requested_at`, and stale `running` scans are failed on worker
>   start. Same guarantees with less machinery. Live status: NOTIFY `scan_events`, one shared
>   LISTEN connection per web process, SSE to the browser.
> - Phase 4: crawling uses HTTP for status/headers/redirects plus a Chromium render to discover
>   JavaScript-created links; capture renders every page at every viewport.
> - Phase 2: the stable issue id (`ISSUE-<n>`) is stored on `issue_track.display_no` (not on the
>   per-scan `issue`), and `issue_track` keeps the latest severity/category/title. `project` has
>   `scan_counter`/`issue_counter`. `packages/security` was created in Phase 2 for URL validation.

## 1. Architecture diagram

```
┌──────────────────────────────── Browser (QA user) ────────────────────────────────┐
│  Next.js UI (React, Tailwind, shadcn/ui)                                          │
│  Dashboard · Projects · Setup wizard · Live scan · Issues · Pages · Reports       │
└──────────────┬───────────────────────────────────────────▲────────────────────────┘
               │ REST /api/v1/* (JSON, zod-validated)       │ SSE /api/v1/scans/:id/events
               ▼                                            │
┌──────────────────────────── apps/web  (Next.js server) ───┴───────────────────────┐
│  Auth (Better Auth, DB sessions) · Route handlers · Authorization (owner checks)  │
│  Upload intake (size/type/magic-byte checks) · Report download · Rate limiting    │
│  Enqueue jobs ──────────────┐                     LISTEN scan_events ◄──┐         │
└─────────────────────────────┼───────────────────────────────────────────┼─────────┘
                              ▼                                           │
                ┌──────────── PostgreSQL 18 ─────────────┐                │
                │ app tables (Drizzle migrations)        │  NOTIFY ───────┘
                │ pg-boss job queue schema               │
                └──────────────▲─────────────────────────┘
                               │ jobs / persistence
┌──────────────────────────────┴──── apps/worker (Node.js) ─────────────────────────┐
│  Scan Orchestrator (state machine, per-step timeouts, cancellation)               │
│                                                                                   │
│  1 Preflight ─ URL validation + SSRF guard + reachability + tech detection        │
│  2 Reference prep ─ DesignSpec snapshot + ContentBlocks snapshot                  │
│  3 Crawler (HTTP) ─ discover/normalize/dedupe, redirects, robots, limits          │
│  4 Browser capture (Playwright) ─ DOM, computed styles, network, console,         │
│                                    screenshots × {desktop, tablet, mobile}        │
│  5 Scanners (independent modules, shared capture data)                            │
│     ├ accessibility (axe-core)      ├ seo                ├ responsive/visual      │
│     ├ security (headers/TLS/mixed)  ├ links (undici)     ├ performance (LH + CDP) │
│     ├ design-compare (DesignSpec vs computed styles)                              │
│     └ content-compare (ContentBlocks vs DOM text)                                 │
│  6 Normalize → RawFinding (+Evidence) · fingerprint · deterministic dedupe        │
│  7 AI interpretation (provider abstraction) ──► 8 Grounding validator             │
│  9 Issue materialization (IssueTrack ↔ Issue occurrence) · comparison w/ previous │
│ 10 Report generation (JSON / Markdown / PDF via Playwright)                       │
└──────┬───────────────────────────────┬────────────────────────────────────────────┘
       │                               │
       ▼                               ▼
  Target website (public internet;  Storage (local FS via Storage interface:
  private ranges blocked by guard)  screenshots, uploads, reports; S3-ready)
       │
  Figma REST API (optional) · AI provider API (optional) — failures → INCONCLUSIVE / "AI unavailable"
```

Key principle: **scanners produce evidence-backed `RawFinding`s deterministically; AI only re-organizes and explains them.** If AI is absent or fails, deterministic issues are still created from raw findings, so the product is fully usable without an AI key.

---

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language across UI, API, worker, scanners; shared zod schemas |
| Frontend | Next.js (latest stable, App Router), React, Tailwind CSS v4, shadcn/ui (Radix), TanStack Table, Recharts (small charts only) | Requested stack; Radix gives accessible primitives |
| API | Next.js Route Handlers under `/api/v1` + zod validation | No second HTTP server to run; long work is **never** done in request handlers |
| Worker | Standalone Node process (`apps/worker`) | Playwright/Lighthouse need long-lived processes; isolates crashes from the web app |
| Job queue | **pg-boss** (Postgres-backed) | No Redis needed (not installed); transactional with app DB; retries, timeouts, cancellation |
| Live status | Postgres `LISTEN/NOTIFY` → Server-Sent Events; UI falls back to polling | Status always read from DB rows (`ScannerRun`), never simulated |
| Database | PostgreSQL 18 (local service), **Drizzle ORM + drizzle-kit SQL migrations** | Typed queries, readable SQL migrations, no native engine binary |
| Auth | **Better Auth** (email + password, DB sessions, httpOnly cookies) with Drizzle adapter | Maintained library rather than hand-rolled crypto; supports orgs later |
| Browser automation | Playwright (Chromium) | Viewports, network/console capture, screenshots, PDF rendering |
| Accessibility | `axe-core` via `@axe-core/playwright` + custom checks (keyboard focus, landmarks) | Industry standard rules, WCAG-tagged |
| Performance | Lighthouse (programmatic, Playwright's Chromium) + CDP/PerformanceObserver metrics + network resource accounting | Lab Core Web Vitals; falls back to CDP-only metrics if Lighthouse fails (marked partial) |
| HTTP checks | `undici` with custom DNS lookup (SSRF pinning), retries + backoff | Fast link checking, header analysis |
| Parsing | `robots-parser`, sitemap XML via `fast-xml-parser`, `cheerio` for static HTML | Mature, small |
| Content docs | PDF: `unpdf` (pdf.js), DOCX: `mammoth` → HTML → blocks, MD: `remark`/`unified`, TXT: line/paragraph heuristics | Pure JS, no external binaries |
| Text diff | `diff-match-patch` + token similarity (normalized) | Shows exact wording deltas as evidence |
| Color math | `culori` (CIEDE2000 ΔE) | Perceptual tolerance instead of exact hex equality |
| Visual diff (optional) | `pixelmatch` + `pngjs` | Figma frame vs screenshot when frames are mapped |
| AI | Provider interface; adapters: **Anthropic (default)**, OpenAI-compatible, `none` | Configurable via env; structured output validated with zod |
| Reports | JSON (versioned schema), Markdown, PDF (HTML template rendered by Playwright `page.pdf()`) | Reuses Playwright; professional typographic control |
| Logging | `pino` structured JSON logs with redaction | Fast; secret redaction paths |
| Testing | Vitest (unit/integration), Playwright Test (app E2E), fixture site | Single runner style for TS |
| Infra | Dockerfiles (web, worker) + docker-compose (postgres, web, worker, demo-site) | Requested; **unverifiable locally until Docker is installed** |

Rejected alternatives: Python backend (would split the codebase and duplicate schemas; Playwright/axe/Lighthouse are first-class in Node). BullMQ/Redis (extra infrastructure not present). Prisma (heavier engine; Drizzle is sufficient).

---

## 3. Folder structure (npm-workspaces monorepo)

```
qa-copilot/
├─ apps/
│  ├─ web/                      Next.js app (UI + /api/v1 route handlers + SSE)
│  │  ├─ src/app/(auth)/        login, signup
│  │  ├─ src/app/(app)/         dashboard, projects/[id]/{overview,scan,issues,pages,scanners,reports,history,settings}
│  │  ├─ src/app/api/v1/        REST handlers (thin: validate → service → respond)
│  │  ├─ src/components/        ui/ (shadcn), layout/, issues/, scans/, charts/
│  │  ├─ src/server/            services, authz, rate-limit, upload intake
│  │  └─ tests/                 component + route tests
│  └─ worker/                   pg-boss consumer, scan orchestrator, pipeline steps
├─ packages/
│  ├─ core/                     domain types, zod schemas, severity, status enums, fingerprint, errors, config loader, logger
│  ├─ db/                       Drizzle schema, migrations, repositories, seed (demo only)
│  ├─ security/                 URL validation, SSRF guard (DNS pinning), upload validation, crypto helpers
│  ├─ crawler/                  HTTP crawler, URL normalization, robots/sitemap
│  ├─ browser/                  Playwright pool, viewport profiles, capture (DOM, styles, network, console, screenshots)
│  ├─ scanners/                 scanner contract + registry
│  │  └─ src/{accessibility,security,seo,links,performance,responsive,design,content}/
│  ├─ reference/                Figma client, DesignSpec normalizer, content extraction (pdf/docx/md/txt)
│  ├─ ai/                       provider interface, adapters, prompts, interpretation, grounding
│  ├─ reports/                  JSON/Markdown/PDF builders + HTML template
│  └─ storage/                  Storage interface (local FS impl; S3 later)
├─ fixtures/
│  ├─ demo-site/                controlled website with intentional, documented defects (demo mode + tests)
│  └─ documents/                sample content PDFs/DOCX/MD, sample design spec JSON
├─ tests/
│  ├─ integration/              full pipeline against fixture site
│  └─ e2e/                      Playwright Test: create project → scan → issues → report → rescan → compare
├─ docker/                      Dockerfile.web, Dockerfile.worker, compose.yml
├─ docs/                        ARCHITECTURE.md, API.md, SCANNERS.md, DEPLOYMENT.md
├─ .env.example
├─ README.md · PROJECT_STATUS.md · IMPLEMENTATION_NOTES.md · CHANGELOG.md
└─ package.json (workspaces), tsconfig.base.json, vitest.workspace.ts, eslint/prettier config
```

---

## 4. Database / entity model

```
User 1─* Project 1─* Scan 1─* ScannerRun 1─* RawFinding *─* Issue (via IssueFinding)
                │          ├─* Page 1─* PageCapture (per viewport)
                │          │        └─* NetworkRequest
                │          ├─* AiRun
                │          ├─* Report
                │          └── designSpecId / contentSnapshot (frozen inputs)
                ├─* ReferenceSource ─* DesignSpec (versioned)
                ├─* ContentDocument 1─* ContentBlock
                ├─* IssueTrack 1─* Issue (one occurrence per scan) ; IssueTrack 1─* IssueStatusEvent
                └─* ScanComparison (baseScanId, targetScanId)
RawFinding 1─* Evidence ; Issue 1─* GroundingCheck
```

| Entity | Key columns (abridged) |
|---|---|
| `user`, `session`, `account`, `verification` | Managed by Better Auth |
| `project` | id, ownerId, name, websiteUrl, isDemo, scanDefaults (jsonb: scanners, viewports, maxPages, maxDepth, auth config ref), createdAt, updatedAt |
| `reference_source` | id, projectId, kind (`figma` \| `manual` \| `guideline_document`), figmaFileKey, figmaNodeIds, status (`ready`/`failed`/`unavailable`), error, fetchedAt |
| `design_spec` | id, projectId, version, tokens (jsonb: typography/colors/spacing/layout/components/assets), **provenance per token** (source: figma node id / document page / user-entered), confirmedByUser, createdAt |
| `content_document` | id, projectId, filename, mime, sizeBytes, sha256, storageKey, parseStatus, parseError |
| `content_block` | id, documentId, order, type (heading/paragraph/list_item/cta/link/emphasis), level, text, normalizedText, href, pageHint |
| `scan` | id, projectId, displayNo, status (`queued`/`running`/`completed`/`completed_with_failures`/`failed`/`cancelled`), configSnapshot (jsonb), designSpecId, contentSnapshotHash, technology (jsonb with signals + confidence), isDemo, startedAt, finishedAt, error |
| `scanner_run` | id, scanId, stepKey (`preflight`,`crawl`,`capture`,`accessibility`,…,`ai`,`grounding`,`report`), status (`pending`/`running`/`completed`/`failed`/`inconclusive`/`skipped`), startedAt, finishedAt, durationMs, findingCount, toolName, toolVersion, error, statusReason |
| `page` | id, scanId, url, normalizedUrl, finalUrl, httpStatus, redirectChain (jsonb), depth, discoveredFrom, title, contentType, crawlError |
| `page_capture` | id, pageId, viewport, screenshotKey, domSnapshotKey, computedStylesKey, consoleMessages (jsonb), timings (jsonb) |
| `network_request` | id, pageCaptureId, url, resourceType, method, status, transferSize, decodedSize, durationMs, failureText, fromCache, isMixedContent |
| `raw_finding` | id, scanId, scannerRunId, pageId, **displayId** (`SEO-023`), scanner, ruleId, title, message, proposedSeverity, verdict (`confirmed`/`potential`/`inconclusive`/`unable_to_verify`), selector, viewport, confidence, expected, actual, **fingerprint**, createdAt |
| `evidence` | id, rawFindingId, kind (`html_snippet`/`header`/`network`/`screenshot`/`measurement`/`computed_style`/`text_diff`/`axe_node`/`console`), data (jsonb), storageKey |
| `issue_track` | id, projectId, fingerprint (unique per project), **status** (`open`/`in_progress`/`resolved`/`reopened`/`ignored`/`inconclusive`), firstSeenScanId, lastSeenScanId, resolvedAt |
| `issue` | id, trackId, scanId, **displayId** (`ISSUE-104`), category, subcategory, severity, title, description, affectedUrls, affectedElement, expected, actual, recommendation, confidence, origin (`ai` \| `deterministic`), groundingStatus (`passed`/`partial`/`rejected→fallback`), createdAt, updatedAt |
| `issue_finding` | issueId, rawFindingId (enforces "every issue references ≥1 real finding") |
| `issue_status_event` | id, trackId, fromStatus, toStatus, userId, note, at (audit trail) |
| `grounding_check` | id, issueId, checkType, passed, detail |
| `ai_run` | id, scanId, provider, model, status, inputTokens, outputTokens, latencyMs, error (no prompts with secrets) |
| `report` | id, scanId, format (`pdf`/`md`/`json`), status, storageKey, sizeBytes, error, createdAt |
| `scan_comparison` | id, projectId, baseScanId, targetScanId, summary (jsonb counts), computedAt (cache; always recomputable) |

Why `issue_track` + `issue`: developer status (Resolved, Ignored…) must survive rescans, while each scan keeps its own immutable occurrence. Fingerprint = hash(scanner, ruleId, normalized URL path, normalized selector/target, viewport-class). This makes **New / Resolved / Persistent / Reopened** computable purely from records.

Comparison rules (base scan B → target scan T):
- **New**: fingerprint in T, not in B.
- **Persistent**: in both.
- **Resolved**: in B, not in T, **and** the producing scanner completed in T and the page was re-crawled. Otherwise → **Not rechecked** (never counted as resolved).
- **Reopened**: track was `resolved` by a user before T, and fingerprint appears in T → track status set to `reopened`.
- **Changed**: same fingerprint, different severity/actual value.
- Scanner status changes: diff of `scanner_run.status` per step.

---

## 5. API structure (`/api/v1`, JSON, all routes authenticated + owner-scoped)

```
GET    /health                         liveness  (public)
GET    /health/ready                   DB + queue + storage checks (public, no details leaked)
*      /api/auth/*                     Better Auth (signup, login, logout, session)

GET    /dashboard/summary              counts across the user's non-demo projects

GET    /projects                       list (search, pagination)
POST   /projects                       create {name, websiteUrl}
GET    /projects/:id                   detail + latest scan summary
PATCH  /projects/:id                   update name/url/scan defaults
DELETE /projects/:id                   soft delete (confirmation in UI)

GET    /projects/:id/reference         reference sources + current DesignSpec
POST   /projects/:id/reference/figma   {figmaUrl, nodeIds?} → fetch & normalize (token from env/project secret)
PUT    /projects/:id/design-spec       manual/JSON design tokens (new version)
POST   /projects/:id/design-spec/extract  from uploaded guideline document → draft (requires user confirmation)

POST   /projects/:id/content-documents multipart upload (pdf/docx/txt/md)
GET    /projects/:id/content-documents
GET    /content-documents/:id/blocks
DELETE /content-documents/:id

POST   /projects/:id/scans             start {scanners[], viewports[], maxPages, maxDepth, authorizationAttested:true}
GET    /projects/:id/scans             history
GET    /scans/:id                      scan + scanner_runs
GET    /scans/:id/events               SSE stream of step status changes
POST   /scans/:id/cancel
GET    /scans/:id/pages                page list with per-category counts
GET    /pages/:id                      page detail: captures, findings by category
GET    /scans/:id/findings             raw findings (filters)
GET    /findings/:id                   raw finding + evidence
GET    /artifacts/:key                 screenshot/evidence file (authz-checked streaming, no path input)

GET    /projects/:id/issues            filters: severity, category, scanner, status, url, confidence, date, q; sort; pagination
GET    /issues/:id                     detail + evidence + source findings + grounding checks + status history
PATCH  /issues/:id/status              {status, note}

POST   /scans/:id/reports              {format: pdf|md|json} → job
GET    /scans/:id/reports
GET    /reports/:id/download

GET    /projects/:id/comparisons?base=&target=   computed comparison
GET    /settings                       non-secret config status (AI provider configured?, Figma configured?)
```

Errors: RFC 9457-style `{type, title, status, detail, requestId}`; never stack traces in production.

---

## 6. Scanner architecture

### Contract (packages/scanners)

```ts
interface Scanner {
  key: ScannerKey;                       // 'accessibility' | 'security' | 'seo' | 'links' | 'performance' | 'responsive' | 'design' | 'content'
  version: string;
  requires: Array<'crawl' | 'capture' | 'designSpec' | 'contentBlocks'>;
  defaultTimeoutMs: number;
  run(ctx: ScanContext, signal: AbortSignal): Promise<ScannerResult>;
}
interface ScannerResult {
  status: 'completed' | 'failed' | 'inconclusive';
  statusReason?: string;                 // e.g. "3/10 pages blocked by WAF (HTTP 403)"
  findings: FindingDraft[];              // validated by zod before persistence
  checks: CheckRecord[];                 // what was checked, incl. passed / unable_to_verify — feeds "Inconclusive checks" in reports
  tool?: { name: string; version: string };
}
interface FindingDraft {
  ruleId: string; title: string; message: string;
  pageUrl?: string; selector?: string; viewport?: Viewport;
  proposedSeverity: Severity; verdict: Verdict; confidence: number;  // 0..1, rule-defined, not guessed
  expected?: string; actual?: string;
  evidence: EvidenceDraft[];             // REQUIRED, min 1 — enforced by schema
}
```

- **Registry** — scanners register themselves; adding a scanner = new folder + registry entry + rule catalog. No orchestrator changes.
- **Rule catalog** per scanner: ruleId → default severity, category/subcategory, remediation template, docs link. Severity is deterministic from rules (e.g. axe `critical`→High, `serious`→Medium…; missing HSTS on HTTPS→Medium). AI may adjust by at most one level with a recorded justification checked by grounding.
- **Shared capture**: crawl + Playwright capture run once; scanners consume persisted `Page`/`PageCapture`/`NetworkRequest` data (and may open their own browser context where needed, e.g. axe, keyboard tests, Lighthouse).
- **Isolation**: each scanner runs with its own timeout + AbortSignal; a throw or timeout marks only that `ScannerRun` failed. Partial coverage → `inconclusive` with reason.

### Scanner specifics

| Scanner | Method | Notable verdict rules |
|---|---|---|
| Accessibility | axe-core per page × viewport; extra checks: tab-order reachability of interactive elements, visible focus indicator sample, landmark presence | axe `incomplete` results → `unable_to_verify`, never confirmed |
| Security | Response headers (HSTS, CSP parse, XCTO, Referrer-Policy, Permissions-Policy, XFO/frame-ancestors), TLS/redirect-to-HTTPS, cookie flags, mixed content from network log, SRI on third-party scripts, passive secret patterns in served HTML/JS (e.g. key formats), server/version banner disclosure | **Passive only.** Optional well-known exposure probes (`/.git/HEAD`, `/.env`) are single safe GETs, **off by default**, require explicit opt-in |
| SEO | title/description length & duplication across pages, canonical, robots meta/X-Robots-Tag, heading structure, alt, OG/Twitter tags, JSON-LD parse validity, robots.txt, sitemap fetch/parse/coverage, URL hygiene, hreflang presence | Duplicates computed across crawled set only (stated in evidence) |
| Links / mixed content | All `<a href>`, img/script/link/src resources; HEAD→GET fallback; 3 retries w/ backoff; per-host concurrency; redirect chain capture | 404/410 twice → **confirmed broken**; 5xx/timeouts after retries → **temporarily unavailable**; 403/429/bot-protection → **inconclusive** |
| Performance | Lighthouse lab run (mobile + desktop) on top N pages; CDP metrics (LCP, CLS, TBT approx, TTFB, DCL, load), resource accounting (JS/CSS/image bytes, request count, render-blocking, oversized images vs rendered size) | Lighthouse failure → CDP-only results with status `inconclusive (partial)` |
| Responsive / visual | Viewports 1440×900, 768×1024, 390×844 (configurable); horizontal overflow (scrollWidth vs viewport + offending elements), clipped text (overflow:hidden with scrollWidth>clientWidth), overlapping interactive elements (bounding-box intersection), tap targets < 24px, font-size < 12px on mobile, broken images (`naturalWidth=0`), nav visible/hamburger toggles and exposes links | Full-page + element-crop screenshots stored as evidence |
| Design compare | DesignSpec tokens vs computed styles of mapped roles (h1–h6, body, button primary/secondary, link, header, footer, container) | Color ΔE2000 ≤2 match, 2–5 potential, >5 mismatch; role not confidently mapped → **Unable to verify** |
| Content compare | ContentBlocks vs DOM text per page | see §7 |

---

## 7. Reference processing (Figma / brand / content)

**DesignSpec** (normalized source of truth, versioned, every value carries provenance):
```json
{ "typography": { "h1": {"fontFamily":"Inter","fontSize":48,"fontWeight":700,"lineHeight":56,"letterSpacing":0, "source":{"type":"figma","nodeId":"12:34"}} },
  "colors": { "primary": {"value":"#1A56DB","source":{...}}, "textPrimary": {...}, "ctaBackground": {...} },
  "spacing": { "scale":[4,8,16,24,32,48], "sectionGap": {...} },
  "layout": { "containerMaxWidth": {...}, "grid": {"columns":12,"gutter":24} },
  "components": { "buttonPrimary": {"background":"color.ctaBackground","radius":8,"paddingX":24, ...} },
  "assets": { "logo": {"storageKey":"...", "sha256":"..."} } }
```
Sources (in priority order, all optional):
1. **Figma REST API** (`FIGMA_ACCESS_TOKEN`): file styles (text/color/effect), published components, selected frames' node properties; frame PNG export for optional visual diff. Variables API is Enterprise-only → used only if available.
2. **Manual entry / JSON upload** in the wizard (always available — Figma is never a hard dependency).
3. **Brand-guideline document** → AI-assisted extraction produces a **draft** spec with page citations; values become active only after the user confirms them.

Missing token → comparisons that need it are recorded as `unable_to_verify` ("Reference value could not be verified"), never guessed.

**Content pipeline**: upload → validation → parse in worker (timeout, size cap) → `ContentBlock`s (type, level, text, normalized text, href, page hint from headings like "Page: About"/doc sections or user mapping).
Comparison: page mapping (explicit user mapping > URL/slug hint > heading similarity ≥ threshold; else block is `unable_to_verify`) → per block: exact normalized match = **Match**; similarity ≥0.85 with diff = **Confirmed mismatch (changed wording)** when page mapping confidence is high, else **Potential mismatch**; not found on a confidently-mapped page = **Missing content**; CTA/link blocks compare text and href separately. Evidence stores reference text, website text, word-level diff, URL, selector, document + location.

---

## 8. AI architecture

```
RawFindings (this scan) ─► deterministic pre-grouping (fingerprint, rule, page clusters)
                         ─► batching by category (token budget)
                         ─► AIProvider.generateStructured(schema=InterpretationSchema)
                         ─► zod parse ─► Grounding validator ─► Issue materialization
                                         │ fail/partial
                                         └► deterministic Issue from findings (origin=deterministic)
```

**Provider interface**
```ts
interface AIProvider {
  id: 'anthropic' | 'openai-compatible' | 'none';
  generateStructured<T>(req: { system: string; input: unknown; schema: ZodSchema<T>;
     model: string; temperature: number; timeoutMs: number; maxOutputTokens: number }): Promise<{ data: T; usage: Usage }>;
}
```
Configured by env (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`/`ANTHROPIC_API_KEY`, `AI_TEMPERATURE`, `AI_TIMEOUT_MS`). Default proposal: Anthropic, model configurable (e.g. `claude-sonnet-5-5` for cost, `claude-opus-5-5` for quality). `none` is valid → AI step `skipped`, deterministic issues only.

**AI input** contains only finding IDs, rule IDs, messages, URLs, selectors, measured values and evidence excerpts (bounded, HTML-escaped, treated as untrusted data — prompt-injection text on target sites cannot issue instructions; output is schema-constrained).

**AI output schema** (per issue): `title, description, category, severity, severityRationale, sourceFindingIds[] (min 1), affectedUrls[], affectedElement?, expected?, actual?, recommendation, claims[{text, findingId, evidenceField}]`.

**Grounding validator** (deterministic, no AI):
1. Every `sourceFindingId` exists **in this scan**; ≥1 required.
2. Each referenced finding has ≥1 evidence record.
3. `affectedUrls` ⊆ URLs of referenced findings; `affectedElement` ⊆ their selectors.
4. Every number, hex/rgb color, px/rem/ms/KB value and quoted string in title/description/expected/actual/recommendation must appear in referenced evidence or the DesignSpec — else claim rejected.
5. Severity within ±1 of max proposed severity of sources, and never raised for `potential`/`inconclusive` verdicts.
6. Category must match source scanners' categories.
7. Coverage: every raw finding ends up in exactly one issue (unassigned → deterministic issue).
Outcomes: `passed` → AI issue shown; `partial` → offending fields replaced by deterministic text, flagged; `rejected` → deterministic issue. All checks persisted (`grounding_check`) and visible in issue detail. Inconclusive sources → issue status `inconclusive`, wording "Unable to verify from available evidence".

**Remediation**: rule-catalog templates (deterministic, include exact expected values from DesignSpec when present) + optional AI-written guidance subject to the same grounding rule (no invented values).

---

## 9. Frontend information architecture

```
Global nav: Dashboard · Projects · Scans · Issues · Reports · Settings          (+ Demo workspace switch, clearly badged)
Project nav: Overview · Scan · Issues · Pages · Scanner Results · Reports · Scan History · Settings
```
- **Dashboard** — DB-derived counts (severity, status), recent scans, failed scanners, projects needing attention. Empty states when no data.
- **New project wizard** — 1 Project (name, URL, live validation) → 2 Figma/Brand (Figma URL or manual tokens / JSON / guideline upload, or skip) → 3 Content uploads (parse status per file) → 4 Configure scan (6 scanners default on + design/content compare when references exist, viewports, crawl limits, optional target auth, **authorization attestation**) → 5 Review → 6 **Start QA Scan**.
- **Live scan** — step list driven by `scanner_run` rows via SSE (Pending/Running/Completed/Failed/Inconclusive + reason, duration, finding count); pages crawled counter from DB; cancel.
- **Issues explorer** — TanStack table, filters (severity, category, scanner, status, URL, confidence, date), search, sort, pagination, bulk status; detail drawer/page with evidence viewer (screenshots, HTML snippet, headers, text diff, measurements), source findings, grounding checks, status history.
- **Pages** — per-page matrix of categories × counts; page detail with screenshots per viewport.
- **Scanner Results** — per scanner status, tool version, checks performed, inconclusive checks.
- **Reports** — generate/download PDF/MD/JSON with status.
- **Scan History / Compare** — pick two scans → New/Resolved/Persistent/Reopened/Changed/Not rechecked lists.
- App accessibility: semantic landmarks, skip link, keyboard-operable tables/dialogs (Radix), visible focus, WCAG AA contrast tokens, `aria-live` for scan status, and we run our own axe checks against the app in E2E tests.

---

## 10. Security design (application + scanning)

- **SSRF**: only http/https; reject credentials in URL, non-standard schemes, IP-literal tricks (octal/hex/decimal), IDN normalized; DNS resolve → block loopback, RFC1918, CGNAT, link-local (incl. 169.254.169.254), multicast, ULA/IPv6 link-local, IPv4-mapped IPv6. Check applied **at every hop** (redirects) and via undici custom `lookup` (prevents DNS rebinding between check and connect). Playwright: `context.route('**')` resolves each request host and aborts private targets; residual rebinding risk in Chromium documented. `SCAN_ALLOWED_PRIVATE_HOSTS` env allowlist for authorized internal targets (e.g. demo site on localhost).
- **Authorization attestation** checkbox per scan start (user confirms they're authorized to test the site); crawl respects robots.txt by default (configurable), polite rate limits, identifiable User-Agent.
- **Uploads**: max size (env), extension + MIME + magic-byte check, random storage keys (no user-supplied paths), stored outside web root, parsed only in worker with timeouts/memory caps, zip-bomb guard for DOCX.
- **XSS**: React escaping; no `dangerouslySetInnerHTML` for scanned content; HTML evidence rendered as escaped text/code; strict CSP on the app itself.
- **SQLi**: parameterized Drizzle queries only. **Command injection**: no shell calls with user input.
- **AuthZ**: every query scoped by `ownerId`; IDOR tests. CSRF: SameSite cookies + Origin checks on mutations. Rate limiting on auth, scan start, uploads.
- **Secrets**: env only, `.env` git-ignored; Figma/AI keys never sent to the browser; per-project secrets (target-site credentials) encrypted with `ENCRYPTION_KEY` (AES-256-GCM); pino redaction.

---

## 11. Observability

pino JSON logs with `requestId`, `userId`, `projectId`, `scanId`, `scanner`, `startedAt`, `finishedAt`, `durationMs`, `status`, `findingCount`, `error` (message + code, no secrets). `scanner_run` rows double as an audit log. `/health/ready` checks DB, queue, storage.

---

## 12. Demo mode

`fixtures/demo-site` — a small static multi-page site served on `localhost:4100` with **documented, intentional defects** (missing alt, contrast failure, missing HSTS/CSP, missing meta description, broken link, oversized image, mobile overflow, wrong CTA color vs demo DesignSpec, changed wording vs demo content doc). Demo projects have `isDemo=true`, live in a separate "Demo workspace", carry a persistent **DEMO DATA** badge, are excluded from real dashboards/reports. The same fixture is the integration/E2E test target, so expected findings are asserted against a known defect manifest.

---

## 13. Development roadmap

| Phase | Scope | Exit criteria (verified) |
|---|---|---|
| 0 | This document | Your approval |
| 1 | Monorepo, TS config, lint, Next.js shell, worker skeleton, env loader (zod), pino, error model, DB connection, `/health` + `/health/ready` | web + worker start; DB connects; health endpoints return 200; unit tests pass |
| 2 | Drizzle schema + migrations (all entities), Better Auth, projects CRUD, settings | Signup/login/logout; project persists across restarts; authz tests |
| 3 | App shell: sidebar, nav, dashboard, project pages, wizard UI, empty/loading/error states (real data only) | UI renders DB data; a11y check of the app |
| 4 | URL validation, SSRF guard, crawler, Playwright capture, viewports, screenshots, tech detection, pg-boss pipeline, SSE status | Crawl of demo site persisted; SSRF unit tests; live status reflects DB |
| 5 | Six scanners + rule catalogs + fixtures | Each scanner tested independently vs fixture defects; failure/timeout paths tested |
| 6 | DesignSpec (Figma + manual + guideline draft), content extraction, design & content comparison | Match / mismatch / potential / unable-to-verify verified on fixtures |
| 7 | AI provider abstraction, interpretation, grounding, deterministic fallback | Grounding rejects fabricated IDs/URLs/values in tests; works with AI=none |
| 8 | Issue tracks, explorer, detail, status workflow, reports PDF/MD/JSON | Reports built from DB; status changes audited |
| 9 | Scan history, comparison, reopen logic, historical dashboard | Comparison counts verified on two real fixture scans (fixture variant toggle) |
| 10 | Hardening: rate limits, upload fuzz, IDOR tests, CSP, Docker, README/DEPLOYMENT, full E2E | Full acceptance workflow (§60) passes |

---

## 14. Dependencies (planned, pinned at install time)

Runtime: next, react, react-dom, tailwindcss, @radix-ui/* (via shadcn/ui), @tanstack/react-table, recharts, lucide-react, zod, drizzle-orm, pg, better-auth, pg-boss, pino, playwright, @axe-core/playwright, axe-core, lighthouse, chrome-launcher, undici, cheerio, robots-parser, fast-xml-parser, unpdf, mammoth, unified/remark-parse, diff-match-patch, culori, pixelmatch, pngjs, @anthropic-ai/sdk, openai (for OpenAI-compatible adapter), ipaddr.js, file-type.
Dev: typescript, tsx, drizzle-kit, vitest, @playwright/test, eslint, prettier, @testing-library/react, msw (AI/Figma mocks), concurrently.

---

## 15. Environment variables (`.env.example` in Phase 1)

| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | postgres://qa_copilot:…@localhost:5432/qa_copilot | yes |
| `APP_URL` | e.g. http://localhost:3000 | yes |
| `BETTER_AUTH_SECRET` | session signing secret (32+ bytes) | yes |
| `ENCRYPTION_KEY` | AES-256-GCM key for stored per-project secrets | yes |
| `STORAGE_DIR` | local artifact storage path | yes (default `./storage`) |
| `MAX_UPLOAD_MB` | upload cap (default 20) | no |
| `AI_PROVIDER` | `anthropic` \| `openai-compatible` \| `none` | no (default `none`) |
| `AI_MODEL`, `AI_TEMPERATURE`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS` | AI tuning | no |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `OPENAI_BASE_URL` | provider credentials | if provider set |
| `FIGMA_ACCESS_TOKEN` | Figma REST API personal access token | no (manual fallback) |
| `SCAN_MAX_PAGES` (25), `SCAN_MAX_DEPTH` (3), `SCAN_PAGE_TIMEOUT_MS` (30000), `SCAN_CONCURRENCY` (3), `SCAN_SCANNER_TIMEOUT_MS`, `LINK_CHECK_RETRIES` (3) | crawl/scan limits | no |
| `SCAN_USER_AGENT` | identifiable UA string | no |
| `SCAN_RESPECT_ROBOTS` | default true | no |
| `SCAN_ALLOWED_PRIVATE_HOSTS` | comma list, e.g. `localhost:4100` for demo | no |
| `DEMO_MODE_ENABLED`, `DEMO_SITE_PORT` (4100) | demo workspace | no |
| `LOG_LEVEL` | pino level | no |
| `RATE_LIMIT_*` | auth/scan/upload limits | no |

---

## 16. Technical risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Figma ↔ DOM element mapping is inherently heuristic | False design mismatches | Role-based mapping with confidence; low confidence → Unable to verify; optional explicit selector mapping in project settings |
| Figma API limits (Variables API Enterprise-only, rate limits, private files) | Missing tokens | Styles/nodes API + manual/JSON fallback; reference marked `unavailable` with reason |
| Bot protection / WAF (Cloudflare etc.) blocks crawler/browser | Partial scans | Detect challenge pages/403/429 → `inconclusive` with reason; never treat as site defects |
| Content page mapping ambiguity | Wrong "missing content" | Require confident mapping for "missing"; else unable_to_verify; user mapping UI |
| Lighthouse instability on Windows/in containers | Missing perf data | CDP fallback metrics; status `inconclusive (partial)` |
| SSRF via DNS rebinding inside Chromium | Internal access | Route-level host checks + resolver pinning for Node HTTP; documented residual risk; worker should run in network-restricted container in production |
| AI cost/latency on large scans | Slow/expensive | Deterministic pre-grouping, batching, token caps, AI optional per scan |
| Prompt injection from scanned page text | Manipulated AI output | Evidence passed as data, schema-constrained output, grounding validator is the final gate |
| Long scans / worker crash | Stuck "running" status | pg-boss heartbeats/expiry; orchestrator marks stale runs `failed` with reason on restart |
| Authenticated target sites | Can't scan behind login | MVP: cookie/header/basic-auth injection (encrypted); scripted login flows later |
| **Docker not installed** | Docker deliverable unverifiable locally | Write & lint Dockerfiles; verify if Docker Desktop is installed, otherwise documented as unverified |
| **Workspace is a temporary scratch folder** | Code lost when session is removed | Move project to a permanent folder before Phase 1 (decision needed) |
| Legal/ethical scanning of third-party sites | Misuse | Authorization attestation, robots respect, rate limits, passive security checks only |

---

## 17. Decisions needed from you before Phase 1

1. **Project folder** — this session runs in a temporary scratch workspace that is deleted with the session. Choose a permanent folder (e.g. `C:\Users\Siddharth\code\qa-copilot`); I will move these docs there and `git init`.
2. **Database credentials** — PostgreSQL 18 is running locally. I'll provide a SQL script to create a `qa_copilot` role/database; you run it (I won't handle your postgres superuser password) and put `DATABASE_URL` in `.env`.
3. **AI provider** — proposal: Anthropic as default adapter (model configurable), plus OpenAI-compatible adapter and `none`. An API key is only needed in Phase 7; everything before works without it.
4. **Docker** — install Docker Desktop for verification in Phase 10, or accept Docker files as unverified-on-this-machine.
5. **Figma** — do you have a Figma personal access token / files to test with? Not needed until Phase 6; manual fallback is built regardless.
