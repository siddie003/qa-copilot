# Enhancement Baseline (Phase 11)

_Created 2026-10-09 in a new Claude Code session. Everything below was verified from the
repository, git history, the databases (read-only queries) and test runs in that session, unless
marked **unverified**. Earlier Claude conversations were not available; their content is known only
through what they left in git and in the project documents._

Read this file first in any future session, then `PROJECT_STATUS.md`, `IMPLEMENTATION_NOTES.md`
and `docs/ARCHITECTURE.md`.

---

## 1. Enhancement programme (Phases 11–16)

| Phase | Scope | State |
|---|---|---|
| 11 | Recover history, audit repository, establish this baseline | Done, approved 2026-10-09 |
| 12 | Free-tier LLM provider, robust error handling, grounding | Done, approved 2026-10-09 (see `LLM_PROVIDER_SETUP.md`) |
| 13 | Large-document extraction, chunking, indexing, retrieval | Done, approved 2026-10-09 (see `LARGE_DOCUMENT_PROCESSING.md`) |
| 14 | Official Figma API, scalable multi-page processing | Done, approved 2026-10-09 (see `FIGMA_INTEGRATION.md`) |
| 15 | UI/UX and plain-language issue explanations | Done, approved 2026-10-09 (see `SESSION_HANDOVER.md`) |
| 16 | End-to-end, regression, security and performance testing; final docs | **Done — awaiting approval** (see `PROJECT_STATUS.md` → Phase 16 results) |
| 15+ | Human-friendly issue explanations (fix guide, two-level issue page, grounded AI explanation, migration 0009) | **Done 2026-10-11 — awaiting review** (see `PROJECT_STATUS.md`, `SESSION_HANDOVER.md`) |

Rules agreed with the user for this programme:
- One phase at a time. After each phase: targeted + regression tests, security/error/performance
  review, update `PROJECT_STATUS.md`, `IMPLEMENTATION_NOTES.md`, `CHANGELOG.md` and the relevant
  docs, report, then **stop** until the user writes `APPROVED — CONTINUE`.
- **No commits** without explicit user authorization. Never discard uncommitted work, reset or
  recreate databases, change credentials or delete user data. Schema changes only via migrations.
- Never fabricate findings, Figma data, extracted text, progress, measurements, quotas or test
  results. Mock tests and live tests are reported separately.

---

## 2. Verified current state (2026-10-09)

| Item | Value |
|---|---|
| Project path | `C:\Users\Siddharth\Downloads\qa-copilot` |
| Branch / HEAD | `main` @ `8365d1e` "Phase 10: production hardening" (2026-10-06 08:31 +0530) |
| Other branches / tags | none / none |
| Phase 10 committed? | **Yes.** `PROJECT_STATUS.md` still says "Phase 10 is not committed yet" — stale (fixed in this phase). |
| Uncommitted changes | None in tracked files. One untracked file: `docs/QA-Copilot-Architecture.pdf` (31 pages, dated 2026-10-06, created after the Phase 10 commit; left untouched and uncommitted). |
| Changes after Phase 10 | No code changes. Only the untracked PDF, plus runtime data (storage files dated 2026-10-07/08) from the user running the app. |
| Running processes at audit time | User's `next dev` on :3000, worker `tsx watch` on :3001, demo site on :4100 (left running, not touched). |
| Node / npm | 22.16.0 / 10.9.2 |
| PostgreSQL | 18.6, service `postgresql-x64-18`, `localhost:5432` |
| Docker | Not installed (Docker files remain unverified) |

### Databases (read-only queries)
| Database | Migrations applied | Contents |
|---|---|---|
| `qa_copilot` (dev, **real user data**) | 7 of 7 (`0000`–`0006`) | 2 users, 5 projects, 14 scans (8 completed, 1 failed, 5 cancelled), 10 424 findings, 288 issue tracks, 13 content documents (all parsed, 400 blocks), 2 reference sources (1 guideline document ready, **1 Figma reference "unavailable"** — no token), **0 AI runs**, 6 reports |
| `qa_copilot_test` (integration tests only; truncated by tests) | 7 of 7 | test leftovers |

### Environment (`.env`; secret values not printed)
- `AI_PROVIDER=none`, `AI_MODEL` empty, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` empty →
  **AI has never run on this installation.** `.env` overrides `AI_TIMEOUT_MS=120000`,
  `AI_MAX_OUTPUT_TOKENS=8000`.
- `FIGMA_ACCESS_TOKEN` empty, no project Figma token → **the live Figma API has never been used.**
- `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` (64 hex), `TEST_DATABASE_URL` set. `MAX_UPLOAD_MB=20`,
  `SCAN_MAX_PAGES=25`.

---

## 3. Reconstructed project history (Phases 0–10)

Sources: 11 commits on `main`, `PROJECT_STATUS.md`, `IMPLEMENTATION_NOTES.md`, `CHANGELOG.md`,
`README.md`, `docs/ARCHITECTURE.md` (Phase 0 plan + per-phase amendments), `docs/DEPLOYMENT.md`
and the untracked architecture PDF. All dates 2026.

| Phase | Commit | Date | Outcome (verified in code) |
|---|---|---|---|
| 0 Architecture & plan | `8f25017` | 10-03 | `docs/ARCHITECTURE.md`: npm-workspaces TS monorepo, Next.js + worker, PostgreSQL as DB **and** job queue (no Redis), evidence-first scanners, AI only explains |
| 1 Foundation | `93a91bd` | 10-03 | Workspaces, env validation (`@qa/core` `getConfig`), pino logging with redaction, health/readiness |
| 2 DB + auth + projects | `100b227` | 10-03 | Drizzle schema (25 tables), Better Auth (email/password), owner-scoped repositories, soft-deleted projects |
| 3 Dashboard / UI | `fe6d1d4` | 10-03 | App shell, dashboard, project area, 6-step setup wizard, UI kit |
| 4 Crawler + Playwright | `5015556`, fix `2bced95` | 10-03 | `scan` row = durable job (`FOR UPDATE SKIP LOCKED`, heartbeat, LISTEN/NOTIFY + SSE live status); undici crawler, robots, Chromium capture per viewport; SSRF layers incl. a guard proxy for Chromium; encrypted site credentials |
| 5 Six scanners | `709eed0` | 10-03 | Accessibility (axe-core), security (passive headers/cookies/HTML), SEO, links + mixed content, performance (lab CWV via PerformanceObserver, no Lighthouse), responsive/visual; zod-validated findings with evidence and fingerprints |
| 6 References | `5b2579b` | 10-05* | DesignSpec with provenance; Figma REST client + normalizer; deterministic guideline extraction; content documents (PDF/DOCX/TXT/MD) → blocks; design (CIEDE2000) and content (similarity) comparison steps; draft/confirm workflow |
| 7 AI + grounding | `8434ee8` | 10-05* | `packages/ai`: deterministic grouping (issue identity), providers (Anthropic SDK, OpenAI-compatible fetch, none), batched interpretation, deterministic grounding validator, rule catalog; AI-assisted guideline reading |
| 8 Issues + reports | `8434ee8` (shared) | 10-05 | Issue explorer/detail, audited status workflow, PDF/Markdown/JSON reports by a report worker loop |
| 9 History + comparison | `7a6180c` | 10-05 | Pure `compareScans` (new/reopened/changed/resolved/persistent/not rechecked/newly checked), reopen rule, history tab + compare page, fixture v1/v2 |
| 10 Hardening | `8365d1e` | 10-06 | Nonce CSP, per-user rate limits, account lockout, DOCX bomb checks, isolated parsing thread, one-active-scan index (0006), step abort signals, stale recovery, graceful shutdown, storage GC, Docker files (unbuilt), smoke test |

\* Phases 6–8 were committed retroactively at the start of Phase 9 (documented in
`PROJECT_STATUS.md` "Git checkpoints"); Phase 6 and 7+8 commits share a timestamp.

Phase test history (from the docs): 249 → 280 → 357 → 394 → 426 → **506** vitest tests; e2e 7 →
10 Playwright specs. Not available to this session: the original "master requirements document"
(its §60 acceptance list is referenced in `PROJECT_STATUS.md` but is not in the repository).

### Known open defects not recorded in `PROJECT_STATUS.md`
The untracked PDF (§5 "Known open defects") lists four; `PROJECT_STATUS.md` says "Known bugs:
none". Status in this session:
1. Report downloads and artifacts get the app-wide CSP from `next.config.ts` headers in addition
   to/instead of their own stricter `default-src 'none'; sandbox` — **code consistent with the
   report** (`next.config.ts` applies a CSP to `/:path*`; the routes set their own); runtime header
   precedence **not re-tested**.
2. Guideline extraction skips typography lines written on consecutive lines without a blank line —
   **unverified**.
3. Comparison: a persistent issue that gained a finding on a newly checked page still says "same
   findings" — **plausible** (the reason string at `packages/core/src/comparison.ts:910`); not
   reproduced.
4. A cancel requested in the last 5 s of a scan is not honoured (5 s heartbeat) — consistent with
   the heartbeat design; not reproduced.
These are recorded here and in `PROJECT_STATUS.md`; none blocks the enhancement work.

---

## 4. Architecture (verified)

```
Browser ──> apps/web (Next.js 16 UI + /api/v1, Better Auth, CSP proxy, rate limits)
                │   writes jobs (rows) + NOTIFY
                ▼
           PostgreSQL 18  <── apps/worker (3 loops: scans, references/documents, reports)
                ▲                 │ Chromium (Playwright) via SSRF guard proxy
           storage/ (local files) │ undici crawler, scanners, AI providers, Figma REST
```
- Jobs are rows: `scan` (scan loop), `content_document.parse_status` + `reference_source.status`
  (reference loop), `report` (report loop); all claimed with `SKIP LOCKED`, LISTEN + 5 s polling,
  stale jobs recovered periodically (failed with a retry hint — **not resumed**).
- Packages: `core` (config, domain, comparison, design-spec, content text utils), `db`, `security`
  (URL/SSRF, upload validation, AES-256-GCM), `storage`, `crawler`, `browser`, `scanners`,
  `reference` (document extraction, Figma, guideline), `ai`, `reports`.
- Scan pipeline (`packages/core/src/pipeline.ts`, `apps/worker/src/pipeline/run-scan.ts`):
  crawl → capture → 6 scanners → design / content comparison (only with references) → `ai` →
  `grounding` (always; creates issues). Each step has its own timeout and abort signal.

---

## 5. Audit answers

### 5.1 AI
- **Providers implemented:** `anthropic` (official SDK, streaming, structured output, refusal
  fallback), `openai-compatible` (plain fetch to `{OPENAI_BASE_URL}/chat/completions` with
  `response_format: json_schema, strict: true`), `none`. Selection: `AI_PROVIDER`
  (`packages/ai/src/providers/index.ts`). Adapters are isolated behind `AIProvider.generateStructured`.
- **`AI_PROVIDER=none`:** the `ai` step is recorded as *skipped* with `NO_AI_PROVIDER_REASON`;
  `grounding` still creates one issue per scanner rule with deterministic text
  (`packages/ai/src/deterministic.ts`) plus fix guidance from the rule catalog
  (`packages/ai/src/catalog.ts`). Guideline documents are read for literal values only.
- **What AI does today:** (a) writes issue text (title, description, severity within ±1 band,
  rationale, recommendation, claims) for groups of findings; (b) assists brand-guideline reading.
  **It does not do approved-content comparison** — content comparison is fully deterministic
  (`packages/scanners/src/content.ts`, text similarity thresholds 0.85 / 0.6).
- **Grounding** (`packages/ai/src/grounding.ts`): rejects unknown/foreign/evidence-less finding
  ids; replaces fields containing numbers, colors, URLs, paths, quotes or ids absent from the
  evidence corpus; severity bounded; outcomes `passed / partial / rejected / not_applicable`
  stored as `grounding_check` rows. Raw findings are never modified.
- **Bounds:** ≤ 10 groups and ≤ 60 000 input chars per request, ≤ 200 groups per scan sent to AI
  (rest keep deterministic text), ≤ 5 sample findings per group, AI step budget = 85 % of
  `SCAN_SCANNER_TIMEOUT_MS`, `AI_CONCURRENCY` (default 3).
- **Reliability gaps (for Phase 12):** OpenAI-compatible retries are fixed `500·3ⁿ` ms without
  jitter, max 2 retries, `Retry-After` capped at 10 s; no distinction between per-minute rate
  limits and exhausted daily quota; no requests-per-minute pacing (free tiers are usually limited
  by RPM/RPD); no provider health check; error text includes up to 300 chars of the provider's
  response body; `strict: true` JSON-schema support differs between OpenAI-compatible providers
  (**not verified** for Gemini/Groq). Never tested against any live provider.

### 5.2 Documents
- **Formats:** PDF (unpdf/pdf.js, headings from font sizes), DOCX (mammoth), Markdown (mdast),
  TXT. Validation: extension + MIME + magic bytes, UTF-8, DOCX zip-bomb checks (central directory
  + streaming inflate of every entry), `MAX_UPLOAD_MB` (20).
- **Synchronous or asynchronous:** asynchronous. Upload stores the file
  (`projects/<id>/documents/<uuid>.<ext>`) and a `content_document` row (`pending`); the worker's
  reference loop parses it in an isolated `worker_threads` thread (512 MB heap, 60 s limit) and
  writes `content_block` rows in one go (`contentRepo.completeDocument`).
- **Chunking / retrieval:** none in the LLM sense. Documents become structural *blocks* (heading,
  paragraph, list item, link, CTA) with `location` = `{ index, page (PDF), line (TXT/MD),
  headingPath }` and `pageHint` from `Page:`/`URL:` markers. Scans load **all** blocks of the frozen
  documents into memory and compare them deterministically with the mapped page's text. No
  full-text index, no embeddings, nothing is sent to an LLM.
- **Source locations:** preserved (page for PDF, line for TXT/Markdown, heading path, block index).
  DOCX has no page numbers (mammoth has none).
- **Hard limits:** `MAX_BLOCKS = 5000` per document (rest dropped, `truncated` + warning),
  `MAX_BLOCK_CHARS = 5000` (block shortened + warning), 60 s extraction, 512 MB heap.
  `listBlocks` UI default 2000. Comparison stores ≤ 500 compared items per step.
- **Coverage reporting gaps:** no per-page extraction status — a PDF with some image-only pages
  silently yields fewer blocks (only a fully image-only PDF fails, "OCR not available"); no counts
  of pages extracted / OCR-required / failed; status values are only
  `pending / processing / parsed / failed`; parsing is all-or-nothing and restarts from scratch.
- **OCR:** not available.

### 5.3 Figma
- **Endpoints (official REST API):** `GET /v1/files/:key` (whole file) or
  `GET /v1/files/:key/nodes?ids=…` when the link has a `node-id`; header `X-Figma-Token`; fixed
  host `api.figma.com`, `redirect: "error"`, 60 s timeout, **50 MB response cap** (bigger files
  fail with `TOO_LARGE` and the advice to link a frame). No `depth`, `geometry`, `version` or
  `branch_data` parameters; no `/styles`, `/components`, `/variables`, `/images` calls.
- **URL parsing:** `packages/core/src/figma.ts` accepts `figma.com/{file|design|proto|board}/<key>`
  + one `node-id`; branch URLs (`/design/<key>/branch/<branchKey>`) are **not** handled.
- **Tokens:** project token encrypted in `project_secret` (kind `figma_token`, write-only API/UI)
  wins over `FIGMA_ACCESS_TOKEN`. Not logged.
- **What is extracted** (`normalize.ts`): local text styles → typography roles, fill styles →
  palette, "Button" components with Primary/Secondary variants, a frame named "Container". The
  tree is walked once from the document root; **pages/frames are not inventoried or tracked**.
- **Page/node caps:** **there is no 25-page (or any page) cap in the Figma code.** The only
  limits are the 50 MB response cap and display truncation of the extraction report
  (`extracted`/`skipped` lists sliced to 100 entries in `apps/worker/src/references/process.ts`).
  The "25" limits in the repository are about **website pages**: `SCAN_MAX_PAGES` default 25
  (crawl, project setting up to 500) and the accessibility scanner's fixed `MAX_PAGES = 25`
  (`packages/scanners/src/accessibility.ts:29`; pages beyond it are recorded as "Not analyzed").
- **Retry / rate limits:** a 429 fails the reference immediately (message shows Retry-After); no
  automatic retry, backoff, caching by version, checkpoints, resume or per-page isolation. One
  failure fails the whole reference.
- **Never tested live** (only against a local mock of the documented responses).

### 5.4 Long-running work and resumability
Scans, documents, Figma references and reports all have persisted status, stale-job recovery and
cancellation for scans. **Nothing resumes:** recovered jobs are failed with a retry hint, and a
retry starts over. Scan cancellation is checked on the 5 s heartbeat.

### 5.5 UX review (from code; no browser walkthrough in this phase)
Already good: 6-step wizard (Project → Figma/brand → Content → Configure → Review → Start) with
hints, examples, per-file page mapping, live processing status, accessible focus handling; issue
detail shows description, pages, element, expected/actual, severity + rationale, confidence, fix
guidance, every source finding with evidence, grounding checks, status history; text origin is
labelled (AI vs scanner wording).
Gaps found:
- The Website URL field accepts a Figma link (no check), so a pasted Figma URL would be crawled.
- Scanner checkboxes show names only — nothing explains what each scanner checks.
- The wizard says a Figma token is needed but does not say whether one is configured, nor offer
  to add it there; AI configuration is only visible read-only in Settings (env-based).
- Issue detail has no explicit "Why it matters", "How to verify the fix" or plain-language
  reliability explanation; the rule catalog contains fix guidance only. Confidence is shown as a
  bare percentage.
- Document status shows parsed/failed but no extraction coverage (pages read, pages without text).
- Figma reference shows ready/unavailable/failed; no page/frame progress (nothing to show yet).

---

## 6. Baseline test results (run 2026-10-09 in this session)

| Check | Result |
|---|---|
| `npm run typecheck` (root + 12 workspaces) | **pass** |
| `npm run lint` | **pass** |
| `npm run format:check` | **pass** |
| `npx vitest run` (unit + integration on `qa_copilot_test`) | **506 / 506 passed**, 53 files (33 unit files / 391 tests, 20 integration files / 115 tests), 271 s |
| `npm run check:tsx-capture` | **pass** |
| `npm run db:check` | OK (PostgreSQL 18.6) |
| `next build` | **not run** — the user's `next dev` was running from the same `.next` folder; Phase 10 recorded a passing build and no code has changed since |
| Playwright e2e (10 specs), `npm run smoke` | **not run** — both use the **development database** (`DATABASE_URL`) and create/delete throwaway accounts; awaiting a decision (see §8) |
| Live AI / live Figma | not possible: no credentials configured |

All results are from real runs; AI and Figma provider tests in the suite use local mocks.

---

## 7. Relevant source files

| Area | Files |
|---|---|
| Config / env | `packages/core/src/config.ts`, `.env.example` |
| AI providers | `packages/ai/src/providers/{types,index,anthropic,openai-compatible}.ts` |
| AI pipeline | `packages/ai/src/{grouping,prompt,interpret,schema,grounding,issues,deterministic,catalog,values,guideline}.ts`, `apps/worker/src/pipeline/issue-steps.ts` |
| Documents | `packages/reference/src/extract/*`, `packages/security/src/upload.ts`, `packages/db/src/repositories/content.ts`, `apps/worker/src/references/process.ts`, `apps/web/src/app/api/v1/projects/[id]/content-documents/route.ts` |
| Content comparison | `packages/scanners/src/content.ts`, `packages/core/src/content.ts` |
| Figma | `packages/core/src/figma.ts`, `packages/reference/src/figma/{client,normalize}.ts`, `packages/reference/src/roles.ts`, `apps/worker/src/references/process.ts`, `apps/web/src/app/api/v1/projects/[id]/figma-token/route.ts` |
| Schema / migrations | `packages/db/src/schema/*`, `packages/db/migrations/0000–0006` |
| UI | `apps/web/src/app/(app)/projects/new/project-wizard.tsx`, `.../projects/[id]/references/*`, `.../projects/[id]/issues/[issueNo]/page.tsx`, `apps/web/src/components/issues/*`, `.../settings/page.tsx` |
| Tests | `**/*.test.ts` (unit), `**/*.int.test.ts` (integration, `_test` DB), `tests/e2e/*.spec.ts`, `tests/smoke/smoke.mjs`, fixtures in `fixtures/` |

---

## 8. Recommended plan and decisions for the user

### Phase 12 — LLM (recommendation)
- Reuse the `openai-compatible` adapter shape; add a dedicated provider entry per free-tier
  service only where its API differs. Candidates to verify against current official docs:
  **Google Gemini API** (free tier; has an OpenAI-compatible endpoint) and **Groq** (free tier;
  OpenAI-compatible). Quotas, context windows, structured-output support and data-use terms will
  be checked and cited, not assumed.
- Add: jittered exponential backoff, full `Retry-After`, client-side RPM/TPM pacing, quota-exhausted
  vs rate-limited classification, provider health check (Settings), JSON-mode fallback with our own
  zod validation when strict schemas are unsupported, response-body redaction in errors.
- Keep grounding as the gate; extend it to any new AI output (content explanations).

### Phase 13 — documents (recommendation)
- Per-page extraction records (pages detected / with text / without text / failed), statuses
  `extracting / indexing / completed / completed_with_warnings / partial / failed / cancelled`
  via migration; remove silent loss (block cap → stored in batches instead of dropped).
- Chunks derived from blocks (section-aware, token-budgeted per configured model) with
  **PostgreSQL full-text search (`tsvector` + GIN)** for retrieval — no vector DB, no paid
  embeddings. Deterministic comparison stays authoritative; AI only explains retrieved, cited
  sections in bounded batches with caching keyed by content hash.
- OCR: not added by default (needs a native/WASM engine); scanned pages are reported as
  "no text — OCR not available".

### Phase 14 — Figma (recommendation)
- Two-stage fetch: `GET /v1/files/:key?depth=1` (pages list + version) → per-page
  `GET /v1/files/:key/nodes?ids=<pageId>` (batched, bounded concurrency), plus `/styles` /
  `/components` metadata where useful; parameters verified against the current docs first.
- Persisted manifest (file version, pages discovered/processed/failed, checkpoints, retries),
  per-page error isolation, version-aware cache, resume, cancellation, Retry-After handling.
- Handle branch URLs and multiple node ids.

### Phase 15 — UX (recommendation)
Website-URL vs Figma-URL guard, scanner descriptions, inline integration status (AI/Figma) in the
wizard, issue detail sections "What / Why it matters / Where / Observed / Severity / How to fix /
How to verify / Reliability", rule-catalog entries for "why" and "verify", coverage displays for
documents and Figma.

### Decisions needed
1. **The "25-page cap" premise.** There is no Figma page cap. The 25-page limits are the website
   crawl default (`SCAN_MAX_PAGES`, already configurable to 500) and the accessibility scanner's
   fixed `MAX_PAGES = 25`. Should Phase 14 (a) only address Figma scalability (the 50 MB
   whole-file limit), and (b) also make the accessibility scanner's 25-page limit follow the
   project's page limit? Recommendation: (a) yes; (b) yes, as a small change in Phase 14 or 16,
   with the time budget taken into account.
2. **Provider and data use.** Free tiers of some providers may use submitted content to improve
   their products. Scan evidence (website text, HTML) and approved-content excerpts would be sent.
   Is that acceptable for this deployment, or should the paid/no-training tier be the documented
   default? (To be verified per provider in Phase 12.)
3. **Live credentials.** Will you provide a free-tier API key (Gemini and/or Groq) and a Figma
   personal access token for live verification? Without them only mock tests are possible.
4. **AI for content comparison.** Recommendation: keep the deterministic comparison as the source
   of findings; AI only explains/summarises mismatches with retrieved citations. Confirm.
5. **E2E and smoke tests use the development database** (they delete only their own throwaway
   `@example.test` accounts). Allow running them against `qa_copilot`, or should Phase 16 add a
   separate e2e database (`E2E_DATABASE_URL`)? Recommendation: separate database.
6. **OCR** for scanned PDFs: leave out (honest reporting) or add an optional local engine
   (e.g. tesseract.js, adds a dependency and CPU cost)? Recommendation: leave out for now.
7. **The four open defects** (§3): fix opportunistically when touching those files (recommended)
   or leave for later.
8. **The untracked `docs/QA-Copilot-Architecture.pdf`**: left as is. Tell me if it should be
   committed or ignored.

### Risks
- Free-tier quotas (requests per minute/day) are far below what a large scan's batching assumes;
  pacing and partial AI coverage must be visible, not hidden.
- Figma rate limits depend on plan/seat and endpoint tier; large files may need many requests.
- `content_block` growth for large documents; retrieval and storage need indexes and batching.
- Every phase must keep the 506 existing tests green and the dev database untouched.
