# Implementation Notes

## Key architectural decisions
- TypeScript monorepo (npm workspaces): `apps/web` (Next.js UI + `/api/v1`), `apps/worker` (scan
  pipeline), `packages/*`. Workspace packages export TS source (`"exports": "./src/index.ts"`);
  Next.js compiles them via `transpilePackages`, the worker runs them via `tsx`.
- One root `.env`, loaded by `@qa/core` `loadEnv()` (walks up to the package.json with
  `workspaces`). Process env always wins over the file. `next start` forces NODE_ENV=production.
- `getConfig()` throws `ConfigError` listing variable names only. Web readiness reports invalid
  config as `not_ready` instead of crashing; the worker exits at startup.
- Logs: pino JSON to stdout, redaction list in `packages/core/src/redact.ts`. `LOG_LEVEL` is read
  directly so logging works even with invalid config. Tests run with `LOG_LEVEL=silent`.
- API errors: throw `AppError(code, message)` from handlers wrapped in `apiHandler()`; 5xx
  messages are never exposed to clients.
- `pg` and `pino` are `serverExternalPackages` in Next.js; the DB pool is cached on `globalThis`
  to survive dev hot reloads.
- Readiness hides filesystem paths and invalid variable names unless `includeDetails`
  (non-production API, Settings page).
- Full nonce-based CSP deferred to Phase 10; `frame-ancestors 'none'` and other safe headers now.
- Versions: Next 16.3, React 19.3, Tailwind 4.3, TypeScript 6.0 (TS 7 not yet supported by
  typescript-eslint), ESLint 9 (eslint-plugin-react lacks ESLint 10 support), Vitest 5, zod 4,
  drizzle-orm 0.45, pino 10.
- PostgreSQL-backed queue (pg-boss) planned for Phase 4; no Redis.
- Live scan status: `scanner_run` rows, then Postgres NOTIFY, then SSE (Phase 4).
- Scanners deterministic and evidence-first; grouping deterministic; AI only explains (writes issue
  text) and the deterministic grounding validator decides what of it is shown (Phase 7).
- `issue_track` (cross-scan status) + `issue` (per-scan occurrence) for scan comparison.
  The human-readable issue id `ISSUE-<displayNo>` lives on `issue_track`, so it stays stable across
  rescans; `issue_track` also carries the latest severity/category/title for fast counts.
  Raw findings get per-scan ids (`SEO-023`).
- Per-project counters (`project.scan_counter`, `project.issue_counter`) are incremented with
  `UPDATE ... RETURNING` for gap-tolerant, race-free numbering.
- Drizzle uses `casing: "snake_case"` in both the client and drizzle-kit config: TS property names
  are camelCase, columns snake_case. Never pass explicit column names that disagree.
- `scanner_run.step_key` is varchar, not an enum, so new scanners need no type migration.
- Projects are soft-deleted (`deleted_at`); repository functions always filter on owner + not deleted.
- Severity counts in project summaries cover outstanding issues only (open, in progress, reopened).

## Phase 2 decisions
- Auth: Better Auth 1.7 with the Drizzle adapter; tables hand-written in `packages/db/src/schema/auth.ts`
  to match Better Auth's core schema. `getAuth()` is lazy (no config needed at build time).
  `createAuth({ withNextCookies: false })` for tests (the nextCookies plugin needs a request scope).
- Session checks: `proxy.ts` (cookie presence only) → `(app)/layout.tsx` `requirePageUser()`
  (database check) → API `authedHandler()` (database check + same-origin check for writes).
- Loading boundaries (`loading.tsx`) only at leaf routes: a boundary above a layout that calls
  `notFound()` makes Next.js stream first and return 200 instead of 404.
- `inputClasses` lives in `components/ui/field-styles.ts` (no "use client") because constants
  imported from a client module into a server component become client references, not strings.
- URL validation is static at save time (`@qa/security`); DNS-resolution checks happen at scan
  time (Phase 4) because DNS answers can change after saving.
- Integration tests: vitest project `integration` points `DATABASE_URL` at `TEST_DATABASE_URL`,
  the global setup migrates it and refuses database names not ending in `_test`; tests truncate
  `"user"` (cascades to everything). Files run sequentially.

## Phase 3 decisions
- Read models live in `packages/db/src/repositories/*` and always join `project` with
  `ownedProjects(ownerId)` (owner, not deleted, real vs demo workspace).
- Server components query repositories directly; client components call `/api/v1` via `apiFetch`.
- `@qa/core/domain` and `@qa/core/figma` are browser-safe subpath exports (the main entry pulls in
  pino/dotenv/fs and must not be imported by client components).
- Figma links are parsed (file key, node ids) and stored as `reference_source` with status
  `pending`; nothing is fetched or invented until Phase 6.
- "Start QA Scan" is rendered disabled with an explanation until Phase 4 (no simulated scans).
- Tooltips use display:none when hidden; visibility:hidden still widens the page.
- Horizontally scrollable containers get `role="region"`, `aria-label`, `tabIndex={0}` (axe
  scrollable-region-focusable).
- Playwright e2e runs a production server on port 3100 (`reuseExistingServer`; stop stale servers
  after rebuilding). Throwaway e2e accounts use `@example.test` and are deleted in `afterAll`.

## Phase 4 decisions
- Job queue = `scan` table (no pg-boss): `claimNextScan` uses `FOR UPDATE SKIP LOCKED`; heartbeat
  every 5 s; `failStaleScans` (2 min) on worker start; LISTEN `scan_queued` + 5 s poll fallback.
- Step rows are created with the scan from `planScanSteps()` (`packages/core/src/pipeline.ts`);
  steps not implemented yet are inserted as `skipped` with the phase in the reason. Add keys to
  `IMPLEMENTED_STEPS` as scanners land.
- SSRF layers: static URL check on save; `assertPublicTarget` before each request/redirect;
  undici dispatcher lookup refuses private IPs at connect time; Playwright `context.route` guard
  (cached per host:port). Residual risk: Chromium resolves DNS itself, so rebinding between the
  route check and Chromium's own connection is theoretically possible. Production should restrict
  worker egress (Phase 10).
- `localhost:4100` typed without a scheme becomes `https://`; the fixture is plain HTTP, so use
  `http://localhost:4100`.
- Robots: 4xx = allow all; unreachable = disallow all (RFC 9309).
- Body sizes reported by Playwright are approximate under request interception; `decoded_size`
  is the server-declared Content-Length (null if absent). `from_cache` is always false.
- Never pass functions containing named inner functions to `page.evaluate` (tsx/esbuild injects
  `__name`). Use string scripts (`TIMINGS_SCRIPT`); regression check: `npm run check:tsx-capture`.
- The migrations folder is resolved from the repo root (bundled apps have a different module URL).
- SSE: one shared LISTEN client per web process (`scan-events.ts`), 300 ms coalescing, stream
  closes on a final status; the client falls back to polling every 3 s.
- E2E: Playwright starts web (3100), worker (health 3191) and fixture (4100) with
  `reuseExistingServer`, so stop stale servers after code changes.

## Phase 5 decisions
- Scanner contract in `packages/scanners/src/types.ts`; registry in `index.ts`; add a scanner by
  adding a module, a registry entry and its key to `IMPLEMENTED_STEPS` (`packages/core/src/pipeline.ts`).
- Worker builds one `ScannerContext` per scan from stored data (`scanner-steps.ts`) and runs each
  selected scanner as its own step (timeout, failure isolation). Findings are re-validated with
  `findingDraftSchema` before storage; invalid ones are dropped and reported as inconclusive.
- Severity: axe impact critical/serious/moderate/minor → critical/high/medium/low (best-practice
  rules one level lower). Performance thresholds are Google's published LCP/CLS/TBT/TTFB/FCP values.
- Link verdicts: 404/410/other 4xx/5xx(non-502-504)/ENOTFOUND/redirect loop = broken;
  timeouts, 502/503/504 after retries, EAI_AGAIN = temporarily unavailable (potential);
  401/403/407/429, private targets, robots-disallowed = inconclusive check (not a finding).
- `analyzablePages()` de-duplicates redirecting URLs by normalized final URL; capture does the same.
- Fingerprint = sha256(scanner, rule, site-relative URL, fingerprintKey|selector, viewport class).
- In-page scripts are strings (`page-scripts.ts`, scanner scripts) because tsx/esbuild injects
  `__name`; `npm run check:tsx-capture` guards this.
- Integration tests use an offline resolver (only localhost resolves) so results never depend on
  the internet.
- Edit scripts: when a shell heredoc fails on quoting, write the script to a file in the repo,
  run it, delete it; always assert anchors exist (silent `str.replace` misses caused one bug).
- Tooling: the file editing tools decode `\uXXXX` in their input into literal characters; write
  escape sequences (e.g. a BOM regex) through a script instead, and never write NUL characters.
  Shell heredocs containing backticks can fail to parse in the agent shell: use a script file.

## Phase 6 decisions
- Shared schemas are browser-safe subpath exports: `@qa/core/design-spec` (DesignSpec, provenance,
  `flattenSpec`/`diffSpecs`/`mergeExtracted`, `specSelectors`) and `@qa/core/content` (accepted
  types, `canonicalText`/`normalizeText`, `textSimilarity`, `containsPhrase`). Extraction and the
  content comparison must normalize text with these same functions.
- Every DesignSpec token has a `source` (zod default: manual). Values edited in the UI become
  manual; untouched values keep their Figma/document citation.
- Versions: `design_spec` rows are immutable; active = newest confirmed; draft = unconfirmed and
  newer than active (at most one, replaced on each extraction). Drafts never feed scans.
  `upsertDraftFromExtraction` locks the project row (`select … for update`) and returns null when
  nothing changes. Merge rule (`mergeExtracted`): manual is never overwritten; Figma replaces
  Figma/document; document replaces document only. A color role belongs to one color.
- Reference jobs: `content_document.parse_status` and `reference_source.status` ('processing'
  added) are the queues, claimed with SKIP LOCKED by a separate loop
  (`apps/worker/src/references`), LISTEN `reference_queued`, 5 s poll, stale (5 min) → failed with
  a retry hint. Uploads are re-validated by the worker before parsing.
- Upload validation lives in `@qa/security/upload` (extension, declared MIME allowlist, magic bytes,
  UTF-8 for text, DOCX central-directory zip-bomb guard: total ≤ 200 MB, ratio ≤ 200, ≤ 5000
  entries, no ZIP64/encryption). Storage keys: `projects/<id>/{documents|guidelines}/<uuid>.<ext>`;
  they are never returned by the API and the artifact endpoint serves only `scans/…` keys.
- `readUpload()` (web) checks Content-Length before `formData()` and the file size after;
  `/api` routes are not matched by `proxy.ts`, so the proxy body limit does not apply.
- Figma: fixed base URL (`api.figma.com`; tests inject a local mock via `ReferenceRuntime.figmaBaseUrl`),
  `redirect: "error"`, 60 s timeout, 50 MB streamed cap. Project token (secret kind `figma_token`)
  wins over `FIGMA_ACCESS_TOKEN`. Role mapping by style name (`roles.ts`) is conservative;
  unmapped styles are listed under "Not used" with the reason.
- Guideline extraction is deterministic (`guideline.ts`): values only when written literally;
  pt → px converted (96/72); a font declaration applied to a role cites both lines in the excerpt.
- Content extraction: shared `BlockCollector` (markers reset the heading path, CTA parsing,
  5000 blocks/5000 chars caps, location). Marker and CTA lines are always standalone (TXT, PDF).
  Markdown: only paragraphs that are a single link become link blocks (inline links stay part of
  the paragraph, to avoid double findings). PDF: lines from pdf.js items, body size = font size with
  most characters, headings ≥ 1.2× body ranked by size.
- Capture: `designStylesScript(selectors)` and `TEXT_BLOCKS_SCRIPT` are strings (tsx `__name` rule).
  Styles are collected at every viewport, text only at the widest, and only when the scan has the
  reference. Native form controls are excluded from the palette (browser default colors).
- Scans: `startScan` freezes `scan.design_spec_id`, `configSnapshot.designSpecVersion`,
  `configSnapshot.contentDocuments` and `scan.content_snapshot_hash`; `planScanSteps(scanners,
  refs)` creates design/content as pending or skipped (`NO_REFERENCE_REASON`). The worker runs
  comparison steps only if they are still pending (`pipelineRepo.pendingStepKeys`).
- Comparison results: all compared items (≤ 500) with verdicts in `checks.comparison`
  (`matched/confirmedMismatch/potentialMismatch/unableToVerify/items`); findings only for
  mismatches. Design findings are site-level (pageUrl null, fingerprintKey = token path) and
  aggregate pages/viewports; content findings belong to the mapped page (fingerprintKey = file +
  rule + normalized text). New evidence kinds: `text_diff`, `design_token`.
- Confirmed vs potential: design mismatches are confirmed only for ΔE > 5 (or a definite size/
  weight/family difference) on elements mapped with confidence ≥ 0.9 (explicit selector, semantic
  HTML); content mismatches only on pages mapped with confidence ≥ 0.9 (explicit mapping or URL
  marker). Everything else is potential.
- Page-name mapping: the best page must beat the next by 0.1, except an exact (≥ 0.99) match,
  which beats near matches ("Products" vs sub-pages titled "Product").
- UI: `<fieldset>` needs `min-w-0` around scrollable tables (min-content default); scroll regions
  that contain `sr-only` spans need `relative`, otherwise the absolutely positioned spans escape the
  scroll container and widen the page. Use `useRefreshWhile()` to poll while jobs process.

## Phase 7 decisions
- `packages/ai` (depends on `@qa/core`, zod, `@anthropic-ai/sdk`; used by the worker only, never by
  the web bundle). Pure modules: `grouping` → `deterministic` + `catalog` → `prompt` → `interpret`
  (provider calls) → `grounding` → `issues` (drafts); `values` is the fact extractor; `guideline`
  is AI-assisted guideline reading.
- **Issue identity is deterministic.** Groups: one per (scanner, rule); design and content: one
  per finding fingerprint. Fingerprint = sha256(`issue-v1` + scanner + rule [+ finding
  fingerprint]); it is the `issue_track` key, so AI output can never split, merge or rename what is
  tracked across scans (keeps Phase 9 comparisons stable). The AI writes text for a group only.
- Group facts: affected pages = finding pages + page URLs in evidence (`page`, `pages`(`.items`),
  `firstSeenOn`, `scannedUrl`, `requested`, `observations[].url|page`, `linkedFrom[].page`; link
  targets/resources are not pages). Verdict: confirmed > potential > inconclusive. Allowed
  severities: within one level of the max scanner severity, never higher without a confirmed finding.
- Deterministic text: single finding = its title/message; groups = shared title + "(N pages /
  elements)", first message + "Found N times (ids) on M pages", "Needs review" note for potential,
  "Unable to verify from available evidence." prefix for inconclusive; expected/actual only when all
  findings agree; recommendation from `catalog.ts` (every non-axe rule has an entry; axe rules use
  the rule's helpUrl from evidence; design uses token/expected/source/actual from evidence; content
  quotes the approved text). `CATALOGED_RULES` + a unit test keep it in step with the scanners.
- Grounding corpus of an issue = its findings (all fields + evidence data incl. keys), group facts,
  its catalog text, WCAG references derived from axe tags (+ "WCAG 2.2 A/AA" scan scope for
  accessibility) and, for design issues, the scan's frozen design spec. Facts checked in AI text:
  numbers (+unit; rounding allowed only to fewer decimals and never small values to integers),
  hex/rgb colors (normalized), URLs (normalized), site paths, quoted text (not code spans), finding
  ids with scanner prefixes (`FINDING_ID_PREFIXES`). Prose without such tokens is not checkable;
  claims add a cited check (field of one finding; no facts → needs a shared significant word).
- Outcomes: hard failure (no/unknown/foreign/evidence-less cited findings) → `rejected`,
  `origin=deterministic`; soft failures replace only the field → `partial`; title + description +
  recommendation all failed → `rejected`; all checks pass → `passed`. No AI text (provider none,
  failed or skipped request, group missing from the response) → `not_applicable` with an
  `ai_output` check explaining why (none when no provider). Checks are stored in validator order
  (`grounding_check.position`).
- Structural zod schema only (no length limits) so one oversized field cannot discard a batch;
  JSON Schema from `z.toJSONSchema` minus `$schema`/constraints, nullable as `anyOf`; all fields
  required (works for Anthropic structured outputs and OpenAI strict mode).
- Anthropic provider: `client.beta.messages.stream(...).finalMessage()`, `output_config.format`
  json_schema (+ `effort` only if `AI_EFFORT` is set), system prompt with `cache_control`, no
  `temperature`/`thinking` (current models reject sampling params; default thinking applies).
  `fallbacks: "default"` + beta `server-side-fallback-2026-07-01` only for `REFUSAL_FALLBACK_MODELS`
  and `AI_REFUSAL_FALLBACK=true`; usage summed over `usage.iterations` when a fallback answered.
  The SDK parses output only for zod-helper formats, so `stop_reason` (refusal, max_tokens) is
  checked before our own JSON.parse + zod. Errors mapped to stable `AIProviderError` codes;
  `auth`/`not_found`/`bad_request`/`not_configured` are fatal (later batches not sent).
- OpenAI-compatible provider: plain fetch to `{OPENAI_BASE_URL}/chat/completions`, strict
  `json_schema` response format, `max_tokens`, `temperature`, 2 retries for 429/5xx/network
  (Retry-After honored up to 10 s), refusal via `message.refusal`/`content_filter`.
- Batches: one category per request, ≤ 10 groups and ≤ 60k input chars, ≤ 200 groups per scan
  sent to AI, ≤ 5 sample findings per group, strings ≤ 240 chars, arrays ≤ 8, depth ≤ 4,
  screenshots omitted. Input JSON is escaped (`<`, `>`, `&` → `<` …) inside
  `<scan_findings>`; the system prompt says the data may contain instructions and must not be
  followed. AI step budget = 85% of `SCAN_SCANNER_TIMEOUT_MS` (abort → remaining batches skipped),
  so the grounding step always runs; `AI_CONCURRENCY` parallel requests.
- Steps: `ai` and `grounding` are planned as pending for every new scan; the worker marks `ai`
  skipped (`NO_AI_PROVIDER_REASON`) without a provider or findings; all AI requests failing makes
  `ai` failed (scan completed_with_failures) but issues are still created. Neither step adds to
  `findingCount` (scan finding totals stay correct); issue counts are in `grounding.checks`.
- Materialization (`scanIssuesRepo.materializeScanIssues`): one transaction, project row locked,
  the scan's issues deleted first (idempotent re-runs), checks: ≥1 finding per issue, each finding
  once, all findings belong to the scan, unique fingerprints. New tracks numbered from
  `project.issue_counter` in group order (severity first). Existing tracks get the latest
  severity/title/category/lastSeen; status is updated only while system-managed (`open`,
  `inconclusive`) — user statuses are kept (Phase 9 added the reopen rule). `issue_finding.raw_finding_id`
  is unique. `ai_run`: one row per sent request (status, tokens, latency, serving model, error,
  detail incl. prompt version); prompts/responses are never stored.
- AI-assisted guideline reading (reference worker, only with a provider, 180 s cap): lines with
  design keywords/values are sent as `L<n>`; a value is kept only if written in its cited line
  (hex/rgb color; number+unit px/pt, pt→px; weight number or keyword; font name substring; role
  named: `h1|heading 1|headline 1`, body/paragraph/copy, link, button, primary/secondary button);
  the color name must be in the line (else "Color <hex>"). Merge: only new color names/values,
  typography roles and buttons absent from the literal extraction. `TokenSource.method = "ai"`
  marks these citations ("read with AI assistance"). Failure → literal draft + `meta.ai`.
- UI: per-scan issues page is the Phase 7 transparency view (no status changes; the issue
  explorer/detail/status workflow is Phase 8). Inline links in text need `underline` (axe
  `link-in-text-block`).

## Phase 8 decisions
- **Reports on demand, not a scan step.** A report reflects issue statuses at generation time, so
  it is requested for a finished scan (`REPORTABLE_SCAN_STATUSES`) and can be regenerated.
  `planScanSteps` dropped `report`; migration `0005` rewords old skipped `report` rows.
- Job = `report` row (pending/running/completed/failed; `started_at` added). `createReport` locks
  the scan row, refuses unfinished scans and a second pending/running report of the same format
  (409), inserts and NOTIFYs `report_queued` in one transaction. The report loop
  (`apps/worker/src/reports`) mirrors the reference loop: LISTEN + 5 s poll, stale (5 min) →
  failed with a retry hint. `completeReport` only succeeds while the row is still `running`; if the
  row was deleted or recovered meanwhile, the file is removed. Running reports cannot be deleted.
- `packages/reports` is pure (no DB, no browser): `buildReportData(ReportSource)` → `ReportData`
  (schema v1, deterministic for a given `generatedAt`), `renderJson`, `renderMarkdown`,
  `renderHtml`. `reportsRepo.loadReportSource` returns the `ReportSource` shape (structural; the
  worker typecheck enforces compatibility). Evidence storage keys never appear in reports
  (`hasStoredFile` only).
- Escaping: Markdown backslash-escapes markdown punctuation and writes `< > &` as entities; lines
  cannot start lists or headings; code spans use a fence longer than any backtick run inside. HTML
  escapes `& < > " '`; the template has no `src`, `href` or `url()`. PDF: Chromium context with
  `javaScriptEnabled: false`, `offline`, route `**/*` aborted, `setContent`, A4, footer with page
  numbers (plain text, escaped).
- Readability: Markdown/PDF finding lines omit expected/actual values identical to the issue's and
  clip long values (240 chars, selectors 160) with an ellipsis; the JSON report keeps everything.
  Technology is shown as site technologies plus `server: …` separately, as on the scan page. The
  PDF steps table keeps Result/Findings/Duration unbroken (`nowrap`).
- Downloads: `GET /api/v1/reports/:id/download` (owner-checked, `attachment`, ASCII file name
  `qa-report-<project-slug>-scan-<n>.<ext>`, `nosniff`, sandbox CSP). Report keys
  `reports/<scanId>/<reportId>.<ext>` are not served by `/api/v1/artifacts` (only `scans/…`). The
  e2e cleanup also removes `reports/<scanId>`.
- Status workflow: `USER_ISSUE_STATUSES` = open, in_progress, resolved, ignored (zod schemas in
  `@qa/core/domain`; note ≤ 2000 chars, trimmed, empty → none). `changeIssueStatus` locks the tracks
  (`FOR UPDATE OF issue_track`), requires every id to be owned (else nothing changes, 404), skips
  tracks already in the target status (no event), sets/clears `resolved_at`, writes one event per
  change (user id, note). Bulk ≤ 100 ids, de-duplicated.
- System events (`user_id` null, `scan_id` set): `materializeScanIssues` writes "First detected by
  this scan." for new tracks and "Status set from the evidence of this scan." when a system status
  (open/inconclusive) changes. Re-running materialization adds no duplicate events. User statuses
  are still kept across scans (Phase 9 added the reopen rule, below).
- Explorer: `lib/issue-filters.ts` is shared by the pages and `GET /api/v1/issues`; invalid values
  are dropped (never 400). The verdict filter groups inconclusive + unable_to_verify as "Unable to
  verify". Latest-occurrence columns (verdict, confidence, page count, origin) come from the `issue`
  row of `last_seen_scan_id`; URL filter = `affected_urls::text ilike` (escaped); "Last detected" =
  creation time of the last scan that saw the issue.
- Issue detail pages use the stable number (`/projects/:id/issues/:displayNo`, `?scan=` for older
  occurrences); the API uses the track uuid (`/api/v1/issues/:id`). The findings view and the
  per-scan issues page link to the detail page with `?scan=`.
- Selected table rows use `bg-primary/5`; text on them must be `text-muted` or darker
  (`text-subtle` drops below 4.5:1 there — caught by the e2e axe audit).
- A `next start` (e.g. a preview server on 3000) started before `npm run build` serves HTML that
  references chunks of the old build: pages render but never hydrate. Restart web servers after
  every build (seen during the Phase 8 manual check; e2e starts its own server on 3100).

## Phase 9 decisions
- **Engine placement.** The comparison is a pure, browser-safe module `@qa/core/comparison`
  (`compareScans`, labels, types) instead of a new package: the web bundle and the worker can use
  it without pulling in crawler/undici code. `pageKey()` (site-relative path + sorted query
  without tracking parameters) mirrors `normalizeUrl` in `@qa/crawler`; the scanners test
  `history-compat.test.ts` keeps them (and the gap-check labels below) in step.
- **Identity.** Issues are matched by `issue_track` (Phase 7 grouping: one track per scanner rule;
  design/content per finding), so AI text never affects comparisons. Inside an issue, findings
  are matched by `raw_finding.fingerprint` (multimap, pairs in order); a second pass pairs
  leftovers by scanner + rule + page key + selector, because the fingerprint's viewport class
  changes when an element is seen at one viewport instead of several (reported as a changed
  finding with a `viewport` field change).
- **"Re-checked" (absence counts as evidence)** for a finding of scan A in scan B: the scanner's
  step exists in B and is `completed` or `inconclusive` (failed/skipped/pending/not selected = no);
  for design the scans have the same `design_spec_id`, for content the same
  `content_snapshot_hash` (includes page mapping); the step has no scanner-wide gap
  (`SCANNER_WIDE_GAP_CHECKS`: links "Link checks" limit); the page (by `pageKey` of url/final URL)
  was crawled in B without error, HTTP < 400 and HTML; the finding's viewport was captured in B
  without error; B's step has no inconclusive check for that page that is page-level
  (`PAGE_LEVEL_GAP_CHECKS`: "axe-core analysis", "On-page SEO", "HTML security checks") or for the
  same rule (`check === ruleId` or starts with `ruleId:`, e.g. axe "needs review" items).
  Truncated inconclusive lists (more than the 200 stored) only add a warning. The same test is
  used in reverse for target findings (new vs newly checked).
- **Issue categories (precedence):** reopened (status event `→ reopened` written by the target
  scan) > in both: changed (severity, verdict class, or findings new / no longer found / changed
  values) else persistent (a different page list alone, e.g. pages not re-checked, is not a
  change; not-rechecked findings are mentioned in the reason) > base only: resolved if every
  finding was re-checked and is gone, else not rechecked ("k of n findings could not be
  re-checked") > target only: newly checked if no finding was checkable in the base, reopened if
  the track occurred in a scan before the base ("Found in scan #x, not found by scan #b, and
  found again by scan #t"), else new. Verdict classes: `inconclusive` = `unable_to_verify`.
  Severity/verdict changes are issue-level; finding changes compare severity, verdict, actual,
  expected, viewport.
- **Lab measurements are not changes.** For `MEASUREMENT_SOURCES` (performance) a different
  `actual` value or worst viewport is recorded with `measurement: true` and shown ("lab
  measurement; varies between page loads"), but does not make a finding or issue "changed"; a
  severity/verdict change (threshold crossed) does. Found by two scans of the same fixture
  version with all six scanners: TTFB 1523 → 1515 ms and worst viewport desktop → mobile; with the
  rule, all 40 issues were persistent.
- **Comparability.** Both scans must be finished (`REPORTABLE_SCAN_STATUSES`; 409 otherwise),
  in the same project (foreign/malformed ids 404), base older than target (400). A scan whose
  `grounding` step is missing (pre-Phase 7) or not completed has no issue records: the result is
  `comparable: false` with the reason, steps are still compared. Warnings: website URL, scanner
  set, viewports, crawl limits, design reference, content documents, scans not `completed`.
  "Comparable scan" = finished + grounding completed; the default pair is the latest comparable
  scan and the comparable scan before it; history compares each scan with its previous
  comparable scan (failed/cancelled scans in between are skipped, with their reason shown).
- **Cache.** `scan_comparison` (existing table, unique base/target pair) stores the summary with
  `version = COMPARISON_VERSION`; other versions are ignored and recomputed. Finished scans and
  the status events their materialization wrote do not change, so summaries stay valid. The
  history page computes missing summaries once (page + trend, ≤ 20 trend scans); the dashboard
  only reads cached ones (`latestCachedForTargets`, closest earlier base).
- **Reopen rule** (`shouldReopen` in `scan-issues.ts`, inside `materializeScanIssues`): track
  `resolved`, occurrence status `open` (confirmed or needs review), and `resolved_at` ≤ scan start
  (`started_at ?? created_at`; null `resolved_at` counts as earlier) → `reopened`, `resolved_at`
  cleared, system event (user null, scan id, note "Found again by this scan after it was marked
  resolved."). Inconclusive occurrences and fixes claimed after the scan started keep `resolved`.
  `reopened` is not a system status: later scans keep it until a user changes it; `in_progress`
  and `ignored` are kept. Re-running materialization writes no second event.
- **No automatic resolving.** Scans never set `resolved`; the compare page offers "Set N
  still-open issue(s) to Resolved" (existing audited bulk API, note naming both scans) only when
  the target is the project's latest comparable scan, so an older comparison cannot override a
  newer detection.
- **Drizzle gotcha:** in a single-table `select`, column references inside `sql` subqueries are
  rendered unqualified ("id" is ambiguous in correlated subqueries). `loadComparisonTracks`
  writes those subqueries as raw SQL with explicit aliases.
- **UI.** Chart = server-rendered SVG (no chart library): stacked bars by severity reusing
  `SEVERITY_MARKERS` colors (critical on the baseline, 2px surface gaps), legend, bars are links
  with hover/focus titles; the SVG has `role="group"` (not `img`, which would make the links
  presentational); the history table is the table view. Compare page: category tiles double as
  filters (`?show=`), categories with their definitions, issue rows with finding details in
  `<details>`, steps table (changed steps first, unchanged collapsed).
- **Scanner fix.** The accessibility scanner records pages beyond its 25-page limit as
  page-level inconclusive checks ("Not analyzed: …"), so their issues are never counted as
  resolved.
- **Fixture versions.** `createDemoSiteServer(state)` / `startDemoSite(port, { variant })` with
  `setVariant`; `POST /__fixture/variant`; `X-Fixture-Variant` request header overrides per
  request. The e2e spec sends the header as the project's custom-header site credential so the
  shared fixture server's state never changes for other specs.
- **E2E log noise.** Leaving a page (or ending a test) while its streamed response is still in
  flight aborts it, which `next start` logs as "The destination stream closed early" (digest
  1715731721). It is timing-dependent (it shows up once in a varying spec per full run, or not at
  all) and fails nothing; the history spec waits for `networkidle` at its end. The compare page's
  per-issue and per-finding links use `prefetch={false}` (dozens of links to heavy pages).

## Phase 10 decisions
- **CSP lives in `proxy.ts`** (Next.js 16 proxy, every page route; not `/api`, `_next/static`,
  icons). Per request: 128-bit nonce, `content-security-policy` set on the request (Next.js reads
  the nonce from it and stamps its scripts) and on the response. `script-src 'self' 'nonce-…'
  'strict-dynamic'` (+ `'unsafe-eval'` and `ws:` only for `next dev`); `style-src 'unsafe-inline'`
  because React `style` props (color swatches, global error page) are inline attributes, which
  nonces do not cover. The root layout calls `connection()` so no page is prerendered without a
  nonce (a prerendered page's scripts would be blocked). HSTS + `upgrade-insecure-requests` when
  `APP_URL` (or, if unset in the proxy's environment, the request) is HTTPS. The static header in
  `next.config.ts` stays for API/asset responses; browsers enforce both. Verified in a real
  browser: all scripts carry the nonce, client navigation works, an injected inline handler is
  blocked (`script-src-attr`). Note: `'strict-dynamic'` trusts scripts created by running scripts
  (DevTools-evaluated code included), so the protection is against injected markup.
- **Rate limits** (`server/rate-limit.ts`): in-memory sliding windows keyed by user id (never by IP,
  so forged forwarding headers do not matter); `authedHandler(route, handler, { rateLimit })`
  checks the bucket after authentication and before the body is read; every authenticated request
  also counts against `api`. 429 problem+json with `Retry-After` (`http.ts`). Integration tests run
  with `RATE_LIMIT_ENABLED=false` (vitest config); the rate-limit test enables it with
  `vi.stubEnv` + `resetConfigCache()`.
- **Sign-in lockout** (Better Auth `hooks`): before `/sign-in/email` the account is checked; after
  it, only a 401 (wrong credentials) counts as a failure and success clears the count. Before-hook
  `APIError`s are rethrown by Better Auth's dispatcher for direct `auth.api` calls but become
  responses on the HTTP route, so tests use the real `/api/auth/[...all]` handler. Next.js sets
  `x-forwarded-for` from the socket only when the header is absent, so without a proxy that
  overwrites it the client chooses the IP Better Auth's per-IP limits see; `TRUSTED_PROXIES` /
  `CLIENT_IP_HEADER` configure Better Auth's `advanced.ipAddress`.
- **DOCX bombs:** JSZip (inside mammoth) compares an entry's size only after inflating all of it, so
  `verifyDocumentContent()` (`@qa/security/upload`) inflates every entry with a streaming
  `createInflateRaw`, counting bytes and aborting as soon as one exceeds its declared size; data
  offsets are computed exactly as JSZip does (central directory offset → local header name/extra
  lengths → compressed size from the central directory). Methods other than stored/deflate are
  rejected. Runs on upload (web) and before parsing (worker).
- **Isolated parsing:** `extractInIsolation()` (`@qa/reference`) runs `extractContentBlocks` in a
  `worker_threads` Worker (`thread-entry.mjs`, plain JS that registers `tsx/esm/api` so the TS
  sources load under the worker's tsx runtime and under vitest), `resourceLimits.maxOldGenerationSizeMb`
  512, hard timeout = extraction limit + 10 s startup, `terminate()` on timeout (stops even
  synchronous loops; verified). `ERR_WORKER_OUT_OF_MEMORY` becomes an `ExtractionError`. Heap
  limits do not cover off-heap buffers, which is why the archive sizes are verified first.
- **Worker reliability:** `runStep` gives each step `AbortSignal.any([scan, step])`; on timeout the
  step signal is aborted and the step gets `stepSettleMs` (10 s) to wind down before the next step
  starts; scanner contexts are re-bound to the step signal (`withSignal`) and `runScannerStep` does
  not store findings once its signal is aborted (a mutation test showed the crawl adding 11 pages
  after the scan had finished without this). Stop reasons: `cancelled` (step skipped "Cancelled by
  user", scan cancelled), `shutdown` (running steps failed "Interrupted…", pending skipped, scan
  failed), `lost` (heartbeat found the scan no longer running under this worker: nothing more is
  written). `stopReason` is read through `currentStop()` because TypeScript narrows the variable
  across awaits. `finishScan(…, workerId)` only updates `running` scans of that worker;
  `failStaleScans` re-checks each candidate inside its own transaction; recovery runs every 60 s
  in each worker loop. Shutdown: `stop({ graceMs })` waits, then aborts (`rt.shutdown`) and waits up
  to 30 s more; reference/report loops just stop waiting after the grace period (their jobs are
  recovered later).
- **One active scan per project** is a partial unique index; `createScan` maps the 23505 on
  `scan_one_active_per_project_uq` (drizzle wraps driver errors: the code is on `err.cause`) to
  `ActiveScanExistsError`; the scan number is not consumed (same transaction). Tests that create
  several scans in one project must finish the previous one first.
- **Error text:** drizzle's `DrizzleQueryError` message is `Failed query: … params: …` with every
  bound value. `stripQueryParams()` is applied to logged messages/stacks/causes (`errorFields`);
  `publicErrorMessage()` (driver code + message, one line, ≤ 500 chars) is used wherever an error
  is stored on a record (step errors, findings storage, reports, documents/references). Better
  Auth's logger is routed through `authLogHandler` (messages and error fields only).
- **Project deletion** (soft delete) now cancels queued scans (steps skipped "Project deleted…"),
  requests cancellation of running ones, and deletes `project_secret` rows, in one transaction.
- **Storage GC** (`apps/worker/src/maintenance/storage-gc.ts`, `npm run storage:gc`): lists only
  recognized layouts (UUID names; symlinks and anything else are "unknown" and never removed),
  loads the referencing rows, pure `planStorageGc`, removal through `storage.removePrefix` (key
  validation). A folder's own modification time counts as activity. Not automatic: the shared
  storage folder of dev and integration-test databases (existing test setup) makes automatic
  deletion unsafe locally; production runs it deliberately.
- **Readiness** (public) is coalesced: one check in flight, result reused for 2 s.
- **Config warnings** (`configWarnings`, production only) are logged by the worker at start and by
  the web process from `instrumentation.ts`, and listed on the Settings page.
- **Docker:** one Dockerfile, `web` and `worker` targets from a shared build (full `npm ci`, `next
  build`, `npm prune --omit=dev`); the worker image installs Chromium with Playwright and runs
  `node --import tsx src/index.ts`; migrations run as a one-shot `migrate` service from the worker
  image. Not verified (no Docker on this machine). `tsx` became a runtime dependency of
  `@qa/worker`, `@qa/db` and `@qa/reference` so `npm ci --omit=dev` keeps working.
- **E2E:** the acceptance spec sends `X-Forwarded-For: 198.51.100.10` so its UI sign-up does not
  use the other specs' per-IP sign-up budget (Better Auth resets that counter only after 60 s
  without sign-ups). Its first run found a WCAG 2.2 target-size failure on scan pages with a
  content/design comparison step (stacked 16 px links); step links are now 24 px tall.

## Environment facts
- PostgreSQL 18 binaries: `C:\Program Files\PostgreSQL\18\bin` (not on PATH). Service `postgresql-x64-18`.
- No Docker, no Redis, no pnpm. Windows 11, Node 22.16.
- Project folder: `C:\Users\Siddharth\Downloads\qa-copilot`.
- Agent sessions: creating the Phase 6–8 checkpoint commits with `git commit-tree` +
  `git update-ref` (Phase 9 session) made the auto-mode permission classifier block several plain
  file reads afterwards ("Git Destructive"). Use ordinary `git add`/`git commit` for checkpoints.

## Unfinished tasks
- None inside Phase 10; all planned phases (0–10) are implemented. Not verified in this
  environment: the Docker image/Compose stack (no Docker), live AI providers and the live Figma
  API (no keys), OS signal handling of the worker on Linux (Windows cannot deliver SIGTERM to a
  Node process; the shutdown logic itself is covered by integration tests).

## Known bugs
- None known. Known log noise: "The destination stream closed early" from `next start` when an
  e2e test leaves a page while a streamed response is in flight (timing-dependent, harmless).

## Commands to resume
```bash
git status && git log --oneline
npm install
npm run typecheck && npm run lint && npm test
npm run db:check
npm run db:migrate     # run after every pull (0006 = one active scan per project)
npm run dev            # web + worker (the worker also processes documents and Figma)
npm run storage:gc     # dry run of the storage garbage collector
npm run demo:site      # fixture website on http://localhost:4100
npx playwright test    # after `npm run build`; stop stale servers on 3100/3191 first
```
Read `PROJECT_STATUS.md`, this file and `docs/ARCHITECTURE.md` first.
