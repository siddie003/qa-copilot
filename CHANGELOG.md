# Changelog

## [Unreleased]

### Scan readiness guard and Figma role fixes (2026-10-22)
#### Fixed
- **Start QA Scan no longer skips the design comparison silently.** A scan uses the design
  reference as it is when it starts. While the design reference is an unconfirmed draft or its
  sources are still being read, or content documents are still processing, the Scan page and the
  wizard's last step list the reasons, link to References and keep the button disabled until the
  user confirms the draft or ticks “Start anyway”. The wizard keeps the button disabled until it
  has checked the reference state (`apps/web/src/lib/scan-readiness.ts`, `start-scan.tsx`).
- **Figma text-style roles:** “Body/CTA” and “Body/Link” are button and link styles, not body
  text, and XXS sizes are skipped like XS. Previously a library grouping its CTA style under
  “Body/” could supply the body font weight (Ascendion: Body/CTA 500 instead of Body/Body-S 300).
- **Links:** a non-standard status code (outside 100–599, e.g. LinkedIn's 999 for automated
  requests, which it also returns for profiles that do not exist) is “inconclusive”, not a
  confirmed broken link.
- **False positives found reviewing the Ascendion scan (2026-10-22):**
  - *Failed resources:* a request the browser stopped (net::ERR_ABORTED, ERR_BLOCKED_BY_ORB) is
    requested once more; an HTTP error is reported as that error (“HTTP 404 (text/html); the
    browser stopped the request”), a resource the server delivers normally (e.g. a video whose
    download Chromium cancels after the first part) is listed in the notes, not reported, and one
    that cannot be checked again is “potential”.
  - *Cookie-consent banners* (HubSpot, OneTrust, Cookiebot, CookieYes, Complianz, Osano,
    Usercentrics, TrustArc, Quantcast, Termly; `packages/browser/src/consent.ts`) are left out of
    design-role styles, page colors, Design Quality text, clipped text, overlaps and touch targets.
    Accessibility checks still include them (visitors use them).
  - *Body text role:* paragraphs inside headings, buttons, links or labels are not body text.
  - *Clipped text:* content moved out of an overflow:hidden box by a transform (word-reveal
    animation masks) is not reported as cut off.
  - *Web font rendering:* a web font whose own family name extends the CSS name (“PP Neue Machina
    Plain”, “IBM Plex Sans SemiCondensed”) counts as the declared font, not a fallback.
  - *Spacing consistency:* inline items (links and spans wrapping inside a paragraph) are not
    measured.
  - *Subresource Integrity:* not expected for evergreen loaders (Google Tag Manager/Analytics,
    HubSpot, Hotjar, Clarity, Facebook, LinkedIn, Stripe, reCAPTCHA); listed in the notes.
  - *Tracking pixels:* a third-party image the browser refused as a non-image (ORB) is listed in
    the notes, not reported as a failed resource (found in the 2026-10-24 Ascendion retest).
  - *Open Graph:* the finding names the missing tags (e.g. “Open Graph tag missing: og:image”).
- **Figma:** a value outside the supported range (e.g. a 9999px pill radius) is skipped and
  reported instead of failing the whole Figma read (2026-10-19).

#### Added
- `fixtures/ascendion/`: Ascendion test package (brand guidelines transcribed from the Figma
  design-system frames, IBM Plex Sans fonts with OFL, approved content from the supplied PDF,
  Figma frame choice, recommended and complete page-link lists with sitemap problems).

### Manager demo package (2026-10-14)
#### Added
- `fixtures/manager-demo/`: "Brightline Studio" demo website with documented, reproducible
  defects and a `fixed` variant (`npm run demo:manager`, `npm run demo:manager:check`), brand
  guidelines, design-values JSON, Geist font files with the OFL licence, approved content,
  Figma-ready design spec, data manifest, end-to-end test guide and manager demo script.

### Workflow redesign and Design Quality & Typography scanner (2026-10-13)
#### Added
- **New Project step:** optional **brand guidelines** (several files) and **font files** (WOFF2,
  WOFF, TTF, OTF) next to the project name and website URL; listed with name and size, removable,
  validated in the browser and uploaded after the project is created with real progress, per-file
  status and Retry.
- **Brand fonts** (`/api/v1/projects/:id/fonts`, References → Brand fonts): a font is stored only
  if its tables can be read; family, style, weight, italic, variable-font flag and licence
  embedding bits come from the file (`@qa/security` `validateFontUpload`, WOFF/WOFF2 decompression
  with output limits).
- **Page links** in Figma / brand (“+ Add page”, list with Remove, same-site/duplicate/file/Figma
  validation) and on the References page (`/api/v1/projects/:id/page-links`). Every scan visits
  them outside the page/depth limits; they are marked “Your page link” on the Pages list and a
  page that cannot be loaded is reported in the crawl step with its status.
- **Design Quality & Typography scanner** (`design_quality`, selectable, default on for new
  projects): heading typography consistency and visual hierarchy per screen size, web fonts that
  did not render (Chromium font engine), text not set in the uploaded brand fonts, images enlarged
  beyond their source or stretched, spacing against the reference spacing scale, near-miss
  alignment, uneven gaps. Heading reference values and approved-content checks are reported from
  the design/content comparisons by cross-reference (no duplicate findings); missing inputs are
  “not configured”, failed ones “not available”, and the step is then inconclusive, not completed.
  Plain-language explanations, fix guides and catalog guidance for all nine `dq-*` rules.
- Scanner results, the scan comparison page and reports show the scanner's parts; the Pages list
  has a Design quality column; project settings show what each scanner checks.
- Fixture site: `/design-quality` (not linked; reachable as a page link) with documented defects.
- Migration `0010_design_quality` (additive): `project_page_link`, `project_font`, `page.origin`,
  `page_capture.quality_key`.
#### Changed
- New Project wizard has five steps: Project → Figma / brand → Configure scan → Review → Start
  scan. The separate **Content** step was removed; content documents (same upload, validation,
  page mapping and processing) are now in Figma / brand. "Figma file link" is labelled "Figma
  design URL".
- Uploading the same file twice to a project as a content document or brand guideline is refused
  (409) instead of creating a duplicate record.

### Issue explanations (Phase 15 extension, 2026-10-11)
#### Added
- **Fix guide for every issue** (`@qa/core/fix-guide`): plain summary (What is the problem? / Why
  does it matter? / What should I do next?), the facts the scan recorded, numbered fix steps,
  before/after code examples where the evidence supports them, caveats, "what the scan could not
  tell" and verification steps. Rule-specific guides for every security, SEO, links, performance
  and responsive rule, design and content comparison, and 23 common axe rules; other rules get a
  general guide from the stored guidance and the axe evidence. Works without AI and for issues of
  earlier scans (built when the page is shown).
- **Issue page in two levels:** In plain language → Where it was found (pages, screen sizes,
  element, recorded HTML, measured facts) → How to fix it → Example fix (copy button) → How to
  verify the fix; then a collapsible **Technical details and evidence** section with the unchanged
  technical card, How reliable, every source finding with its raw evidence and screenshots, and
  Evidence validation. `#evidence` links open the section.
- Scan issue list: each expanded issue starts with the plain summary and links to the full guide.
- **Scan findings page** (`/scans/:id/findings`, raw findings such as `A11Y-024`): every finding now
  opens with the same guide built from its own evidence (problem, why, next step, where, fix steps,
  example fix, verification, link to its issue); the scanner message, rule, element, expected/actual,
  confidence and raw evidence moved into a collapsible "Technical details and evidence" section.
  The guide is built in the browser when a finding is opened (the linked finding on the server),
  keeping the page at 0.77 MB for 57 findings instead of 1.56 MB with every guide pre-rendered.
- Reports (Markdown, PDF/HTML, JSON): plain summary, fix steps and verification per issue
  (`plainLanguage` in JSON); the stored recommendation is kept and labelled as such.
- **Optional AI explanation:** the AI may return `explanation` (problem, impact, next step, fix
  steps, caveats). Each part passes the existing evidence check or is replaced by the built-in
  guide (steps all-or-nothing, caveats one by one); checks are stored and shown. AI never writes
  code examples. Prompt version `issues-2026-10-11-explain`.
- Migration `0009_issue_explanation`: nullable `issue.explanation jsonb` (additive).
#### Changed
- The "Explanation" card was replaced by the cards above; technical details are collapsed by
  default. Evidence validation names the new explanation checks.
- Report label "How to fix" → "Recommendation stored with the issue" (the new "Fix steps" come
  first).

### Live Figma enablement (2026-10-10)
#### Fixed
- Figma text colors: taken only when every text layer using a style has the same fill (text
  styles have no color in Figma); otherwise skipped with "used with N different colors". Found on
  a real file, where it produced unsupported "confirmed" color mismatches.
#### Changed
- Configuration (`.env`, not committed): `FIGMA_ACCESS_TOKEN` set. `FIGMA_INTEGRATION.md` §0 records
  the live verification.

### Live AI enablement (2026-10-10)
#### Fixed
- Gemini 429 classification: Google sends the same "exceeded your current quota … plan and
  billing" message for per-minute and per-day limits; a per-minute limit was treated as an
  exhausted quota and stopped AI for the rest of the scan. Structured quota ids (`…PerDay…` vs
  `…PerMinute…`) now decide; the message is only a fallback.
#### Changed
- Configuration (`.env`, not committed): Gemini `gemini-3.6-flash`, concurrency 2, 5 requests per
  minute (the live free-tier limit). `LLM_PROVIDER_SETUP.md` §0 records the live measurements.

### Phase 16: Final integration, regression, security and performance validation (2026-10-09)
#### Fixed
- **Stored files lost their sandboxing policy.** The site-wide `Content-Security-Policy` from
  `next.config.ts` replaced the stricter header of screenshot/snapshot artifacts and report
  downloads (`default-src 'none'; sandbox`). Those two routes are now excluded from the static
  header and carry `frame-ancestors 'none'` themselves. Verified on a production build; asserted
  in the acceptance e2e test. (HTML snapshots were and are served as `text/plain` + `nosniff`.)
- **Brand guideline lines without blank lines between them were not read at all** (they form one
  paragraph block). Blocks are now split where a typography role or a font declaration starts.
- **Comparison wording:** a persistent issue that was also found on parts the earlier scan could
  not check no longer says "same findings"; the reason names the newly checked findings.
- **Cancel near the end of a scan** was ignored when the remaining steps finished before the next
  5-second heartbeat. The worker now checks for a cancel before every step.
- **Findings page performance:** 100 findings per page (`?page=`, `?finding=<id>` opens the page
  of a linked finding, links from issues and comparisons updated). A 6,625-finding scan went from
  a 64 MB page in 9.1 s to 1.3 MB in 0.3 s.
- **Compare page performance:** at most 50 issues per category on the overview, 200 per page in a
  single category. 3,750 compared issues went from a 26 MB page to 0.66 MB.
- Evidence of a scan's findings is grouped in one pass (was quadratic) and loaded in id chunks of
  10,000 (one id list could exceed PostgreSQL's 65,535 parameters on very large scans). The first
  attempt (a join with `ORDER BY created_at`) changed the order of evidence items with equal
  timestamps and was caught by the run-scan integration test.
#### Added
- `pipelineRepo.listFindingDisplayIds`; paging option on `listFindingsForScan`.
- Tests: IDOR matrix extended to the Phase 13–14 routes (content search, document cancel,
  reference cancel); guideline paragraph extraction; comparison wording; cancel between
  heartbeats (with a mutation check); findings paging; CSP headers of stored files (e2e).
#### Changed
- `references.spec.ts` (e2e) expected the pre-Phase-13 label "Parsed"; it now expects "Completed".

### Phase 15: UI/UX and plain-language issue explanations (2026-10-09)
#### Added
- Plain-language explanation on every issue page (`PlainExplanation`): What it means, Why it
  matters, Where it occurred, What was observed, How serious, How to fix, How to check the fix,
  How reliable. Rule wording comes from a fixed catalog (`@qa/core/explain`: every rule the
  scanners emit, the common axe-core rules, category fallbacks); pages, elements, values, counts
  and confidence come from the stored occurrence. Uncertain verdicts are explained first; a
  suggested fix is labelled "not verified until a later scan confirms it"; Resolved / Reopened /
  In progress / Ignored explain what the status does and does not prove.
- Severity meanings, verdict meanings, confidence explanation and one-line scanner descriptions
  (`SEVERITY_MEANINGS`, `VERDICT_MEANINGS`, `CONFIDENCE_EXPLANATION`, `SOURCE_DESCRIPTIONS`).
- Specific fix guidance for common axe-core rules (image-alt, color-contrast, link-name,
  button-name, label, html-has-lang, document-title, heading-order, target-size, region,
  landmark-one-main), with the rule documentation link.
- Setup wizard: a Figma link in the Website URL field is refused (client and server, error code
  `figma_url` on create, update and validate-url); a non-Figma address in the Figma field is
  explained; warning when no Figma token is configured; scanner descriptions; "what happens next"
  notes (Figma reading, AI on/off); the final step shows each reference's real status and message.
- Issue list: stacked cards on phones (the table needs ~960px), result count, secondary filters
  folded into "More filters" (opened automatically when one is active).
- Scan page: step summary on the Progress card ("N of M steps finished · x failed · y skipped").
- `Alert` tone `warning`; `Card` `anchor` prop.
#### Changed
- Issue page: the scanner/AI description, rule id, full page list and claims moved to
  "Technical details (for developers)" below the explanation; evidence and validation unchanged.
- AI prompt (`PROMPT_VERSION` `issues-2026-10-09-plain`): descriptions in plain language without
  jargon; recommendations stay developer-ready. Grounding is unchanged.
- Wizard copy distinguishes the live website (step 1), how it should look (step 2: Figma, brand
  guideline, manual values) and what it should say (step 3: approved content).

### Phase 14: Figma API and multi-page processing (2026-10-09)
#### Added
- Figma reads through the official REST API with as few file-content (Tier 1) requests as
  possible: `GET /v1/files/:key/meta` first (an unchanged version after a complete read makes no
  file-content request), the whole file when it fits `FIGMA_MAX_RESPONSE_MB`, otherwise the page
  list (`depth=1`) and the pages in batches through `GET /v1/files/:key/nodes`, pinned to the
  listed version. Oversized or failing (5xx) batches are split; a single bad page is recorded as
  failed and the others are read. Batch size adapts after a split.
- Persisted manifest (`reference_source.manifest`): version, read mode, every page with status,
  frames (id, name, type, size), node counts, requests per rate-limit tier, retries, rate-limit
  details (Retry-After, plan tier, seat type, upgrade link), warnings, runs. Checkpoint with the
  pinned version, pending pages and collected values: reads resume after rate limits, network
  errors, cancellation and worker crashes, requesting only the missing pages.
- Rate limits: short `Retry-After` waits are honoured (`FIGMA_MAX_RETRIES`,
  `FIGMA_MAX_RETRY_WAIT_MS`); longer ones stop the read as **Partial** with a draft of the pages
  read and the plan/seat details shown.
- Cancel (`POST /api/v1/projects/:id/references/:refId/cancel`), "Continue reading", states
  Partial / Ready with warnings / Cancelled; manifest summary on the References page.
- Branch links (`/design/<key>/branch/<branchKey>/…`) use the branch key.
- `SCAN_ACCESSIBILITY_MAX_PAGES` (default 0 = every page of the scan) replaces the fixed 25-page
  accessibility limit; pages not reached within 80 % of the step timeout are reported as
  "Not analyzed" instead of the step timing out.
- Configuration: `FIGMA_MAX_RESPONSE_MB`, `FIGMA_PAGES_PER_REQUEST`, `FIGMA_TIMEOUT_MS`,
  `FIGMA_MAX_RETRIES`, `FIGMA_MAX_RETRY_WAIT_MS`. `FIGMA_INTEGRATION.md`.
- Migration `0008_figma_pages` (additive; ready references get outcome `completed`).
#### Changed
- The Figma normalizer is split into `collectFigma` (per tree, serializable state) and
  `finalizeFigma`; `normalizeFigma` gives the same results as before.
- Figma HTTP 5xx is reported as `SERVER_ERROR` (was `NETWORK`).
- Extracted/skipped value lists keep up to 1,000 entries with their totals (was 100, cut
  silently); the UI says how many are not shown.
- Stale references are re-queued (3 attempts) instead of failed at once.

### Phase 13: Large-document processing (2026-10-09)
#### Added
- PDFs are read page by page in an isolated thread and stored in batches (pages 1–30, then 25 per
  batch), each with coverage and a checkpoint. Every page is reported: with text, blank,
  image-only (scanned; OCR not available) or failed with its error — a failing page no longer
  fails the document.
- Persisted states: Upload received, Extracting text (real "N of M pages read"), Indexing sections,
  Completed, Completed with warnings, Partial, Failed, Cancelled; coverage summary on the References
  page and in the setup wizard.
- Cancel (`POST /api/v1/content-documents/:id/cancel`) and Continue reading (retry of cancelled or
  partial documents resumes at the checkpoint); stale runs are re-queued and resumed (3 attempts).
- Retrieval sections (`content_chunk`, section-aware, page range, heading path, block range,
  offsets, hash) with a PostgreSQL full-text index; search API
  `GET /api/v1/projects/:id/content-search` and a search box on the References page; indexing job
  for documents parsed before this phase.
- AI explanations of content issues receive the approved section their finding comes from (exact
  block → section lookup, ≤ 2 × 800 characters); it is part of the grounding corpus.
- Identical uploads in the same project reuse the earlier results.
- UTF-16 text files with a byte-order mark are accepted.
- Configuration: `DOCUMENT_EXTRACTION_TIMEOUT_MS`, `DOCUMENT_PARSER_MEMORY_MB`, `DOCUMENT_MAX_BLOCKS`,
  `DOCUMENT_CHUNK_TOKENS`.
- `LARGE_DOCUMENT_PROCESSING.md`; tests (unit, rendered components, real-database integration).
#### Changed
- Block cap 5,000 → `DOCUMENT_MAX_BLOCKS` (50,000); reaching it makes the document Partial.
  Shortened blocks are counted. Extraction time limit 60 s → 300 s per run.
- Scans compare only the blocks that existed at scan start and report partially read documents as
  inconclusive ("Only partly read: …"); content evidence names its source block.
- Retry is also available for cancelled and partial documents.
- Migration `0007_large_documents` (additive; existing parsed documents get an outcome from their
  stored details; their sections are built by the worker).
#### Fixed (found by the new tests before release)
- A run cancelled while its last batches were being stored could have been reported as complete.
- The block cap of non-PDF documents was not recorded in the coverage.

### Phase 12: Free-tier LLM integration (2026-10-09)
#### Added
- `AI_PROVIDER=gemini` (Google Gemini API, OpenAI-compatible endpoint, `GEMINI_API_KEY`) and
  `AI_PROVIDER=groq` (`GROQ_API_KEY`), both through the existing OpenAI-compatible adapter.
- Retry and quota handling: full-jitter exponential backoff, `Retry-After` (seconds or HTTP date)
  and Google `RetryInfo`, `AI_MAX_RETRIES`, `AI_MAX_RETRY_WAIT_MS`; new error codes
  `quota_exhausted` (daily/billing quota, never retried, stops the scan's remaining requests) and
  `too_large`; Gemini `API_KEY_INVALID` (HTTP 400) is an authentication error; Groq best-effort
  schema mismatches (HTTP 400) are `invalid_output`, not a configuration error.
- Client-side pacing per worker process: `AI_REQUESTS_PER_MINUTE`, `AI_TOKENS_PER_MINUTE`.
- `AI_MAX_INPUT_TOKENS` (batch size), `AI_MAX_ISSUES_PER_SCAN`, `AI_STRUCTURED_OUTPUT`
  (`json_schema` | `json_object`); `AI_EFFORT` is sent as `reasoning_effort` to OpenAI-style
  providers.
- Provider health check `npm run ai:check` (one tiny request, no scan data).
- Settings page: AI request limits and a data-use notice per provider.
- `LLM_PROVIDER_SETUP.md` with verified provider facts (2026-10-09), setup and troubleshooting.
- Tests: `packages/ai/src/free-tier.test.ts` (30 mock tests) and a real-database integration test
  of the Gemini preset against a mock endpoint (rate limit retried, quota exhausted, all issues
  created, findings unchanged).
#### Changed
- `AI_TEMPERATURE` is optional: unset → 0 for `openai-compatible` (as before), provider default for
  `gemini`/`groq`.
- Provider error messages include at most 200 characters of the provider's message, without the
  key or key-shaped strings (was 300 characters of the raw body).
- Credential-shaped strings and credential-like URL parameters are removed from AI input;
  guideline AI input is bounded by `AI_MAX_INPUT_TOKENS` and reports relevant lines not sent.
- A single issue group larger than the request limit is not sent (kept in the scanners' wording,
  recorded as `too_large_input`). `ai_run.detail` and the AI step record request attempts.
- Anthropic: HTTP 413 → `too_large`; "credit balance" errors → `quota_exhausted`; SDK retries follow
  `AI_MAX_RETRIES` (default 3, was 2).

### Phase 11: Enhancement baseline (2026-10-09)
#### Added
- `ENHANCEMENT_BASELINE.md`: reconstructed history of Phases 0–10, verified git/database/test
  state, audit of AI providers, document processing, Figma integration and UX, recommended plan
  for Phases 12–16 and decisions needed.
#### Changed
- `PROJECT_STATUS.md`: enhancement programme section; corrected the stale note that Phase 10 was
  uncommitted; recorded four open defects listed in `docs/QA-Copilot-Architecture.pdf`.
- `IMPLEMENTATION_NOTES.md`: Phase 11 audit notes.
- No application code, configuration, schema or data changed.

### Phase 10: Production hardening (2026-10-05)
#### Security
- Nonce-based Content-Security-Policy on every page (`proxy.ts`, `lib/csp.ts`): scripts only with
  the per-request nonce + `strict-dynamic`, no inline handlers, `frame-ancestors 'none'`,
  `object-src 'none'`, `upgrade-insecure-requests` on HTTPS; HSTS for HTTPS deployments. All
  pages render per request so their scripts carry the nonce.
- Per-user API rate limits (all requests, scan starts, uploads, reports, design references, new
  projects) with 429 + `Retry-After`; `RATE_LIMIT_ENABLED`.
- Failed sign-ins limited per account (10 per 15 minutes, independent of the client IP); per-IP
  limits configurable for reverse proxies (`TRUSTED_PROXIES`, `CLIENT_IP_HEADER`). The sign-in
  form shows the wait time.
- DOCX uploads: every archive entry is decompressed (counted, not kept) and must match its
  declared size, closing zip bombs that understate their content; unsupported compression and
  out-of-range entries are rejected. Checked on upload and again by the worker.
- Documents are parsed in a worker thread with a 512 MB heap limit and a hard time limit.
- Site credentials: control characters (header injection) and colons in Basic usernames refused.
- Deleting a project cancels its queued/running scans and deletes its stored site credentials and
  Figma token.
- Database errors are reduced to the driver's code and message wherever they are stored or shown
  (`publicErrorMessage`); logs never contain bound query parameters (`stripQueryParams` in
  `errorFields`); Better Auth's own log output goes through the structured logger.
- Chromium scan and PDF contexts refuse downloads.
- The public readiness endpoint shares one check between concurrent requests and reuses it for 2 s.
#### Reliability
- One queued or running scan per project, enforced by a unique index (concurrent starts → 409).
- Stale scans, documents, Figma reads and reports are recovered every minute (not only at worker
  start), race-safe across workers.
- Heartbeats and the final scan status are bound to the owning worker: a scan recovered elsewhere
  is never overwritten.
- Each pipeline step has its own abort signal: a timed-out step is stopped and cannot store
  findings after the scan moved on; scanner findings are not stored once their step was stopped.
- Graceful worker shutdown: running scans get `WORKER_SHUTDOWN_GRACE_MS`, then are recorded as
  failed ("the worker was shut down") with what they stored; a database failure during a scan
  still records a final state.
- Storage garbage collection (`npm run storage:gc`, dry run by default).
#### Deployment
- `Dockerfile` (web and worker targets), `docker-compose.yml` (PostgreSQL, migrate, web, worker),
  `.dockerignore`, `deploy.env.example` — not verified (no Docker available).
- `docs/DEPLOYMENT.md`: production configuration, reverse proxy, operations, security checklist.
- `tsx` is a runtime dependency of the worker, the database package and the reference package.
- Configuration warnings for risky production settings (logged at start, shown in Settings);
  `WORKER_HEALTH_HOST` for container probes.
#### Database
- Migration `0006_production_hardening`: unique partial index `scan_one_active_per_project_uq`
  (queued duplicates are cancelled first, with a reason).
#### Tests
- Security integration tests: IDOR matrix over every API route, concurrent scan starts, rate
  limits, account lockout over the real auth route, forged-size DOCX upload, header injection.
- Worker reliability integration tests (real Chromium): step timeout stops work, shutdown,
  ownership loss, stale recovery, migration 0006 duplicate cleanup.
- Upload fuzzing, DOCX content verification, isolated parsing (runaway and memory-hungry
  parsers), CSP, proxy, rate limiter, config, error sanitization, download refusal, storage GC.
- End-to-end acceptance workflow with CSP checks on every page.
#### Changed
- `pipelineRepo.finishScan` only finishes `running` scans (and, with a worker id, only the owner's).
- The project deletion dialog explains that scans are stopped and credentials deleted.

### Phase 9: Scan history and comparison (2026-10-05)
#### Added
- Comparison of two finished scans (`@qa/core/comparison`): new, reopened, changed, resolved,
  persistent, not rechecked and newly checked issues with finding-level detail and reasons;
  scanner/step status changes; warnings for different settings; "not comparable" for scans
  without issue records. Resolved only when the target scan re-checked every finding.
- Reopen logic: resolved issues found again with evidence become Reopened (audited system event).
- Scan history tab (latest changes, issues-per-scan chart, scan picker, history table), compare
  page with confirm-resolved action, "Compare with scan #n" on scans, changes on the dashboard.
- API `GET /api/v1/projects/:id/comparisons`, `GET /api/v1/projects/:id/history`; summaries
  cached in `scan_comparison`.
- Fixture site versions v1/v2 (`POST /__fixture/variant`, `X-Fixture-Variant` header).
- Unit, integration (real DB; real Chromium v1 → v2 → v1 scans) and end-to-end tests.
#### Changed
- The accessibility scanner reports pages beyond its 25-page limit as not analyzed.
- Issues that a user marked resolved are now reopened by a scan that finds them again with
  evidence (previously user statuses were always kept); the Phase 7 test was updated accordingly.
#### Fixed
- Comparisons do not report performance issues as changed when only a lab measurement varied
  between page loads (measured value or worst viewport); a crossed threshold still counts.

### Phase 8: Issue management and reporting (2026-10-05)
#### Added
- Issue explorer (all projects and per project): filters for severity, status, verdict
  (confirmed / needs review / unable to verify), scanner, affected page URL, minimum confidence and
  last detection, search by title or `ISSUE-n`, sorting, pagination; columns for verdict,
  confidence, affected pages, last scan and number of scans; row selection with bulk status change.
- Issue detail page (`/projects/:id/issues/:n`): description, affected pages, element,
  expected/actual, severity rationale, fix guidance, evidence-backed statements, every source
  finding with its evidence, grounding checks, all scans the issue was found in (older occurrences
  viewable) and the status history.
- Audited status workflow: Open, In progress, Resolved, Ignored with optional note; every change
  stored in `issue_status_event` with user, time, previous status and note; scans record first
  detection and evidence-based status changes as system events. Inconclusive and Reopened stay
  system-only. `resolved_at` maintained.
- Reports generated on demand from finished scans in PDF, Markdown and JSON (versioned schema
  `qa-copilot-report` v1): scan settings, all pipeline steps with failed/inconclusive/skipped
  reasons, checks that could not be verified, and every issue with status, verdict, fix guidance and
  source findings (JSON: full evidence). Built only from stored records; website text escaped;
  PDF rendered by Chromium with JavaScript disabled and the network blocked.
- `packages/reports`; report worker loop (LISTEN `report_queued`, stale recovery); `renderPdf` in
  `@qa/browser`; Reports tab with format choice, live status, download and delete; Reports button
  on finished scans; downloads on the global Reports page.
- API: `GET /api/v1/issues`, `GET /api/v1/projects/:id/issues`, `GET /api/v1/issues/:id`,
  `PATCH /api/v1/issues/:id/status`, `POST /api/v1/issues/status` (bulk),
  `GET/POST /api/v1/scans/:id/reports`, `GET/DELETE /api/v1/reports/:id`,
  `GET /api/v1/reports/:id/download`.
- Migration `0005_issue_workflow_reports` (`issue_status_event.scan_id`, `report.started_at`,
  report status index); unit, integration (real database, real Chromium PDF) and end-to-end tests.
#### Changed
- Scans no longer plan a "Report generation" step (reports are generated on demand); the reason on
  older scans' skipped report step was reworded by the migration.
- Issue links in the explorer, the findings view and the scan issues page open the issue detail
  page.
#### Fixed
- Nothing outstanding from Phase 7.

### Phase 7: AI interpretation and grounding (2026-10-04)
#### Added
- `packages/ai`: AI provider abstraction with three providers: Anthropic (official SDK,
  streaming, structured JSON output, opt-in server-side refusal fallback), OpenAI-compatible
  (Chat Completions with strict JSON schema, retries) and none.
- Deterministic pre-grouping of findings into issues (one issue per scanner rule; one per design
  token or content block) with stable fingerprints, facts (affected pages from findings and
  evidence, element counts, verdict, allowed severities) and deterministic issue text: scanner
  wording plus a rule catalog with fix guidance for every rule the scanners emit.
- AI interpretation in batches per category (bounded input, website data escaped and marked as
  untrusted, static cacheable system prompt, concurrency limit, time budget, failure isolation;
  configuration errors stop further requests).
- Deterministic grounding validator: rejects AI text citing findings that do not exist or belong
  to another issue (or without evidence); replaces any field whose numbers, colors, URLs, page
  paths, quotes or finding ids are not in the issue's evidence, counts, rule guidance or design
  reference; keeps severity within one level (never raised for unconfirmed findings); checks the
  affected element and every cited claim; enforces the "Unable to verify from available evidence"
  wording. AI never sets affected URLs, category, fingerprint, findings or confidence.
- Pipeline steps `ai` (AI analysis; skipped with the reason when no provider is configured) and
  `grounding` (evidence validation and issue creation; always runs). Issues are stored with
  tracks (stable `ISSUE-n` numbers per project, user statuses kept), finding links (each finding
  in exactly one issue, enforced by a unique constraint), grounding checks and one `ai_run` per AI
  request (tokens, latency, serving model, error; no prompts or responses stored).
- AI-assisted brand-guideline reading: values the AI proposes are kept only if written in the line
  they cite (colors, sizes with unit, weights, font names, named roles); literal values win; the
  result is still a draft to confirm; citations are marked "read with AI assistance".
- Scan issues page (per-scan interpretation and grounding report with filters, AI requests,
  source findings and every check), `GET /api/v1/scans/:id/issues`, "View issues" on the scan
  page, issue links on findings, Issues tab linked to the latest occurrence, AI settings shown in
  Settings, AI-assisted reading summary on the References page.
- Migration `0004_ai_interpretation`; config `AI_EFFORT`, `AI_REFUSAL_FALLBACK`,
  `AI_CONCURRENCY`; tests: provider mocks for both APIs, grounding (fabricated ids, URLs, values,
  quotes, paths, severity, claims), batching, issue materialization on the real database,
  guideline grounding, fixture pipeline coverage, API and end-to-end checks.
#### Changed
- Defaults: `AI_TIMEOUT_MS` 300000 (was 120000), `AI_MAX_OUTPUT_TOKENS` 16000 (was 8000).
- The findings view no longer says issues come "in a later phase".
#### Fixed
- Nothing outstanding from Phase 6.

### Phase 6: Design and content references, comparison (2026-10-04)
#### Added
- DesignSpec schema with per-token provenance, versioning with drafts and confirmation; token
  editor with JSON import/export (References page and setup wizard).
- `packages/reference`: Figma REST client and normalizer (text/color styles, Button
  Primary/Secondary components, Container frame); deterministic brand-guideline extraction with
  citations; content extraction from PDF (font-size headings, page numbers), DOCX, Markdown and
  TXT with page markers and CTA targets.
- Reference worker loop in the worker: parses uploaded documents, reads Figma files, extracts
  guideline drafts; stale-job recovery; status in the worker health endpoint.
- Document upload validation (extension, MIME, magic bytes, UTF-8, DOCX zip-bomb guard) and
  storage under random keys; per-project Figma token stored encrypted (write-only).
- Design comparison step (computed styles of mapped roles, CIEDE2000 colors, pixel tolerances,
  palette near-misses) and content comparison step (page mapping, exact / changed wording /
  rewritten / missing / capitalization, CTA text and targets, word-diff evidence); both report
  match, confirmed mismatch, potential mismatch and unable to verify.
- Capture of computed styles and visible text when a scan has references; scans freeze the
  confirmed design spec version and the parsed documents.
- References tab, comparison report per scan, evidence rendering for word diffs, color swatches
  and computed-style observations; findings filter for design/content; wizard steps for Figma,
  guideline, manual values and content uploads with live processing status.
- API: design spec, draft confirm/discard, guideline and content document uploads, document
  mapping/blocks/retry/delete, reference refresh/delete, Figma token.
- Migration `0003_reference_processing`; fixture design spec, approved content, Figma response and
  DOCX/PDF builders; unit, integration and end-to-end tests (280 vitest, 7 Playwright).
#### Changed
- Fixture website: documented design and content differences (stylesheet, About and Products copy).
- Responsive scanner: its design-spacing inconclusive check now points to the design comparison.
#### Fixed
- `packages/storage` was excluded from git by the `storage/` ignore pattern (now `/storage/`).
- Setup wizard's last step offered a disabled "Start QA Scan" with outdated wording; it now starts
  scans. Outdated Phase 4 note on the Scan page.

### Phase 5: Six QA scanners (2026-10-03)
#### Added
- `packages/scanners`: scanner contract (validated findings with mandatory evidence, check
  summaries with inconclusive checks), registry and six scanners: accessibility (axe-core + keyboard
  focus), security (passive configuration checks), SEO, broken links/mixed content, performance (lab
  Core Web Vitals and budgets), responsive/visual (layout measurements + live mobile-menu test).
- Capture collects lab Core Web Vitals (PerformanceObserver) and layout/image/render-blocking
  metrics; stored in `page_capture.metrics`.
- Findings persisted with per-scan display ids (A11Y-001 …), evidence rows and stable fingerprints;
  scanner check summaries in `scanner_run.checks`.
- Findings view with filters and evidence; findings counts on the scan page, Scanner results tab and
  dashboard; findings API.
- Fixture website: documented defects for every scanner, Basic-auth members area, slow page,
  valid generated PNG.
#### Changed
- Capture runs viewports in parallel and skips redirect duplicates; accessibility analysis runs
  three pages at a time (full fixture scan ~108 s → ~38 s).
- Redirecting URLs that reach an already-analyzed page are analyzed once (no duplicate findings).

### Phase 4 fixes (2026-10-03)
#### Fixed
- DNS-rebinding gap in Chromium closed with a local guard proxy.
- Bare `localhost:PORT` input defaults to http://; HTTPS handshake failures explain the scheme.
- `from_cache` stored as NULL (unknown) instead of false.
#### Added
- Site authentication (HTTP Basic, custom header, cookies), encrypted per project, sent to the
  scanned site only; settings UI and wizard step; scan-auth API.
- `WORKER_CONCURRENCY` for parallel scans per worker.

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
