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

## Phase 11 notes (enhancement baseline)
- Full audit in `ENHANCEMENT_BASELINE.md`. Key facts for the next phases: there is **no Figma
  page cap** (the 25-page limits are `SCAN_MAX_PAGES`' default and the accessibility scanner's
  `MAX_PAGES`); Figma is one whole-file request with a 50 MB cap; approved-content comparison is
  deterministic (no AI, no retrieval); documents are parsed all-or-nothing into ≤ 5000 blocks
  with page/line/heading locations but no per-page coverage.
- **Playwright e2e and `npm run smoke` use the development database** (`DATABASE_URL`; they create
  and delete `@example.test` / throwaway accounts). Only vitest's integration project is pointed at
  `TEST_DATABASE_URL`. Ask before running them while the dev database holds user data.
- Do not run `next build` while a `next dev`/`next start` from this repository is running.
- Agent shells: a stray `cat > file` without input blocks until the command times out; write
  temporary scripts with the file tools (inside the workspace when they need workspace packages)
  and delete them afterwards.

## Phase 12 decisions (free-tier LLM)
- **No new adapter for Gemini/Groq.** Both are presets of `OpenAICompatibleProvider` (fixed base
  URLs `GEMINI_OPENAI_BASE_URL`, `GROQ_BASE_URL`; `id`/`label`/`apiKeyVariable` per preset) built
  in `createAIProvider`. Tests inject `geminiBaseUrl`/`groqBaseUrl`/`retryBaseMs` via
  `ProviderOverrides`. A native Gemini SDK was not added (no new dependency).
- **Classification** (`classifyHttpError` + `parseErrorBody`, object or `[{error}]` bodies):
  401/403 or `API_KEY_INVALID` → auth (Gemini answers 400 for bad keys); 413 → too_large;
  429 → `quota_exhausted` when the text/quota ids say per-day/daily/TPD/RPD/`insufficient_quota`/
  billing, else `rate_limit` (Google's per-minute message also mentions "plan and billing", so the
  regexes require a quota-ish phrase; the quota id `…PerDay…` is the reliable signal); 400 with
  `json_validate_failed`/"does not match the expected schema" → invalid_output (non-fatal);
  408/5xx → unavailable. `FATAL_AI_ERRORS` gained `too_large` and `quota_exhausted`.
- **Retries:** rate_limit/unavailable/network only; wait = Retry-After (seconds or HTTP date) or
  Google `RetryInfo.retryDelay`, else full jitter `rand·min(30 s, base·2^n)`; a stated wait above
  `AI_MAX_RETRY_WAIT_MS` ends the request (> 10 min → quota_exhausted). Waits use
  `abortableSleep` on the request's deadline signal (cancellation/budget end them at once).
- **Pacing** (`providers/pacing.ts`): rolling 60 s window per process, shared per
  provider+model+limits (`sharedPacer`), FIFO admission, estimate = body chars / 3 +
  `AI_MAX_OUTPUT_TOKENS`, replaced by reported `total_tokens` after the answer; a single request
  above the TPM budget throws `too_large` before sending. Multiple worker processes do not share it.
- **Batch size:** worker computes `maxChars = AI_MAX_INPUT_TOKENS·3 − SYSTEM_PROMPT.length`
  (≥ 2000; default 20000 tokens ≈ the old 60 000-char constant). A single group above it is a
  batch with `oversize: true` → skipped `too_large_input` (keeps scanner wording).
- **json_object mode** appends the JSON Schema to the system prompt; `parseStructured` strips a
  Markdown code fence before `JSON.parse`; zod validation is unchanged.
- **Temperature:** `AI_TEMPERATURE` became optional; `openai-compatible` keeps 0, presets omit it
  (Google recommends Gemini 3's default). `AI_EFFORT` → `reasoning_effort` (xhigh/max → high).
- **Data minimization:** `scrubSecrets` (prompt.ts) on every string of the group input, titles,
  page URLs and guideline lines: key/token patterns and credential-like query-parameter values.
  The grounding corpus still uses the unscrubbed evidence (an AI quoting a scrubbed value simply
  fails that fact check).
- `describeConfig` adds `aiLimits` and `aiDataNotice` (provider terms as of 2026-10-09; wording
  points to the terms). `ai:check` = `apps/worker/src/scripts/ai-check.ts` → `checkAIProvider`
  (packages/ai/src/health.ts); the web bundle still never imports `@qa/ai`.

## Phase 13 decisions (large documents)
- **Job model unchanged, finer state.** `content_document.parse_status` stays the queue
  (`pending → parsing → parsed | failed | cancelled`); `stage` (extracting/indexing) and `outcome`
  (completed / completed_with_warnings / partial) are separate columns, `documentState()` in
  `@qa/core/content` maps them to the UI states. `coverage` (jsonb, `DocumentCoverage`) and
  `checkpoint` (jsonb `{ extractorVersion, pdf: PdfState }`) are written with every batch in one
  transaction with its blocks (`appendDocumentBatch`), so a resumed run can trust them.
- **Streaming thread protocol** (`thread-entry.mjs`): `start {totalPages}` → `batch` × n → `done`
  | `error`. `extractStreamInIsolation` serializes `onBatch` calls; after an abort (cancel or lost
  run) queued batches are skipped and the result is `cancelled` even if `done` already arrived (a
  test caught the case where it reported `done` with batches skipped). Batches before a time or
  memory stop are kept (`time_limit` / `stopped`); with no batch it is an `ExtractionError` as
  before. `extractInIsolation` (guideline documents) collects all batches.
- **PDF:** `openPdf` wraps pdf.js (`getDocumentProxy`, per-page `getTextContent` + `cleanup`,
  `getOperatorList` image ops for pages without text, `loadingTask.destroy`). `PdfPageSource` is an
  interface so tests can inject a failing page. Body size from the first `PDF_SAMPLE_PAGES` (30)
  pages; heading sizes accumulate; `BlockCollector` takes/returns `CollectorState` (next index,
  page marker, heading path) and `drain()`s per batch. Block order = `location.index` (global).
- **Resume rules:** only PDFs with the same `EXTRACTOR_VERSION` ("2"); `prepareDocumentRun`
  deletes blocks with `order >= checkpoint.nextIndex` and all chunks; DOCX/MD/TXT start over.
  `recoverStaleDocuments` → pending while `attempts < 3` (cancel-requested stale runs →
  cancelled), else failed; stale `indexing` of parsed docs → released. A heartbeat every 5 s
  refreshes `processing_started_at` and reads `cancel_requested_at`; a missing row means the run
  lost the document (stop writing).
- **Indexing** is a stage of processing and also a lowest-priority job (`claimNextIndexing`: parsed,
  `chunk_count = 0`, blocks > 0) for documents parsed before chunking existed. A failed indexing
  job keeps `stage = 'indexing'` until stale recovery (5 min) to avoid a hot retry loop.
  Do not pass huge numbers to integer columns (an overflow was the first indexing bug).
- **Search:** `searchTerms()` (core, browser-safe: letters/digits ≥ 3 chars, stopwords removed,
  longest first) → `to_tsquery('simple', …)`; `searchChunks` tries all words (`&`) then any word
  (`|`). The tsvector is a generated column over `coalesce(heading_text,'') || ' ' || text`.
- **AI context:** content evidence carries `documentId` + `blockOrder`; `attachApprovedSections`
  (issue-steps) loads the containing chunks (`chunksForBlocks`), ≤ 2 per group; `groupInput` sends
  `approvedSections` bounded to 800 chars after `scrubSecrets`; `issueCorpus` includes the full
  section text. `PROMPT_VERSION` → `issues-2026-10-09` (rules 3 and 7 mention approvedSections).
- **Scans:** `ScanContentDocument` gained `outcome` and `coverageNote`; `loadReferences` filters
  blocks to `order < blockCount` (frozen size); the content scanner adds an inconclusive check per
  partial document. Snapshot hash appends `:blockCount` only for partial documents (complete
  documents keep their old hash, so older scans stay comparable).
- **Dev database:** migration 0007 was applied to the development database on 2026-10-09 (backup
  taken first with `pg_dump -Fc` into the session scratchpad); its 13 documents were then indexed
  by the running worker (98 sections).
- **Test hook:** `ReferenceRuntime.afterDocumentBatch` (tests only) makes cancellation and crash
  tests deterministic.
- Agent shells: inline `node -e` scripts containing template literals break in bash double quotes;
  use the Edit tool or a script file (written with the Write tool) instead.

## Phase 14 decisions (Figma multi-page)
- **Quota first.** Figma Tier 1 (GET file / GET nodes) is the scarce resource (View/Collab seats:
  up to 20 per month). Order: `meta` (Tier 3) → skip if `prev.complete && prev.version ===
  meta.version` and the same kind of read → whole file (1 request) unless the previous read was
  page mode → else `depth=1` + `nodes` batches. Meta failures (403 scope, rate limit, network) are
  warnings; meta 404 is fatal (the file would 404 anyway).
- **`readFigmaReference`** (`packages/reference/src/figma/pages.ts`) is the orchestrator; it is pure
  apart from the client and an `onProgress(manifest, checkpoint) → continue?` callback the worker
  uses to persist after the page list and every batch (and to stop on cancel). It clones the
  incoming checkpoint. Results: `unchanged` | `done` | `stopped` (RATE_LIMITED, NETWORK,
  SERVER_ERROR outside a batch, CANCELLED) with a checkpoint.
- **Batches:** `nodes?ids=…&version=<from depth=1>`; TOO_LARGE or SERVER_ERROR on several pages →
  split in halves (batch size remembered for later batches); on one page → that page `failed`.
  Null node entries → `failed` ("not returned for this version"). A stop inside a split batch
  keeps the pages already done (pending = manifest pages still pending).
- **Normalizer:** `collectFigma(state, root, styles)` records the first node per style with its
  values (not node references), buttons with their computed token, the first container frame;
  `finalizeFigma(state, key)` builds the spec/report exactly as before (`normalizeFigma` = collect
  all roots + finalize; existing tests unchanged). Style metadata merges from the whole-file,
  depth=1 and per-node `styles`.
- **Worker** (`apps/worker/src/references/figma.ts`): heartbeat 5 s (lost → stop writing; cancel →
  abort client), outcome rules: stopped + 0 pages done → `failed` (checkpoint kept if pages
  pending); stopped with pages → `ready/partial` with a draft from the pages read + checkpoint;
  pages failed → `partial`; warnings → `completed_with_warnings`; FigmaError otherwise → `failed`,
  checkpoint cleared; CANCELLED → `cancelled` with checkpoint. Unchanged → `ready`, previous
  outcome kept, note "unchanged".
- `reference_source`: `outcome`, `manifest`, `checkpoint`, `attempts`, `cancel_requested_at`
  (migration 0008; status enum + `cancelled`). `claimNextReference` increments attempts;
  `recoverStaleReferences` cancels (if requested), re-queues (< 3 attempts) or fails.
- The web layer strips `frames` from manifests sent to the browser (`getReferenceState`); the API
  `GET /projects/:id/references` returns them. The checkpoint is never returned (not in columns).
- **Accessibility cap:** `ScannerContext.limits = { accessibilityMaxPages, deadline }`; the worker
  passes `SCAN_ACCESSIBILITY_MAX_PAGES || snapshot.maxPages` and, per step in `withSignal`, a
  deadline at 80 % of `SCAN_SCANNER_TIMEOUT_MS`. Jobs after the deadline are not started and their
  pages get the page-level "axe-core analysis" inconclusive check (so comparisons never count
  their issues as resolved). Status counts exclude skipped combinations.
- **Dev database:** migration 0008 applied 2026-10-09 after `pg_dump -Fc`
  (`qa_copilot_before_0008.dump`, session scratchpad).
- Test hooks: `ReferenceRuntime.afterReferenceBatch`, `figmaMaxBytes`, `figmaRetryBaseMs`.
  Generated Figma files: `fixtures/figma/large-file.mjs` (`buildFigmaFile`, `figmaResponse`).

## Phase 15 decisions (UI/UX, plain-language issues)
- **Deterministic explanations, not new AI fields.** `packages/core/src/explain.ts` holds fixed
  wording per rule (meaning, impact, optional manual check) plus category fallbacks; it never
  contains issue facts (a unit test rejects digits and URLs in the category wording). Everything
  specific on the page (pages, element, expected/found, counts, confidence, verdict, severity
  rationale, fix text) is read from the stored occurrence. Reasons: works with `AI_PROVIDER=none`
  (the current installation), needs no migration, cannot invent findings. The AI prompt was only
  asked to write plain-language descriptions (shown under Technical details with their grounding
  label); no new AI output fields, so grounding is unchanged.
- **Coverage test:** `grouping.test.ts` asserts that every rule the scanners emit (and every design
  rule) has a specific explanation, next to the existing remediation-catalog check. Unknown axe
  rules get the category wording plus "General explanation for this kind of check".
- **Never "verified":** the fix text is always labelled "not verified until a later scan confirms
  it"; Resolved explains that only a later scan of the same pages confirms it (reopen rule from
  Phase 9); the re-scan sentence names the comparison categories (Resolved vs Not rechecked).
- **Plain view keeps long technical values out:** expected/found longer than 160 characters (e.g.
  axe failure summaries) are only in Technical details.
- **Website vs Figma:** `normalizeWebsiteUrl` (create, update, validate-url) refuses
  `figma.com`/`*.figma.com` with field error code `figma_url`; the wizard checks the same on the
  client and explains a non-Figma address in the Figma field. The Figma token warning appears only
  for a well-formed Figma link and only when `FIGMA_ACCESS_TOKEN` is empty (a project token can be
  added on the References page after creation).
- **Issue list on phones:** a second, card-based rendering (`md:hidden`) shares the selection
  state; the table is `hidden md:block`. Role-based e2e locators ignore the hidden copy.
- **Browser testing without touching real data:** the app role cannot `CREATE DATABASE`, so the
  disposable integration database `qa_copilot_test` was used: production build on port 3200 and
  a worker on health port 3291 with `DATABASE_URL=TEST_DATABASE_URL`, a scratch `STORAGE_DIR` and
  the test-only encryption key; Playwright e2e the same way (ports 3100/3191). Integration tests
  truncate that database, so they never run at the same time as these servers.

## Phase 16 decisions (final validation)
- **Static CSP vs route CSP:** Next.js `headers()` *replaces* a route's header of the same name
  (seen on the production build). `next.config.ts` therefore applies its static CSP to
  `/:path((?!api/v1/artifacts/|api/v1/reports/[^/]+/download).*)` only; those routes keep
  `default-src 'none'; …; sandbox; frame-ancestors 'none'`. Pages get the proxy's nonce policy,
  other API routes the static one.
- **Guideline segments:** `guidelineSegments()` splits a block before `H1–H6 / Heading n / Body /
  Paragraph / Link / Button` followed by a separator (`: - – — |`) and before font declarations
  (`Primary font:`), but never right after a scope word (`Primary` stays with `font:`). Each
  segment cites the block (first line of the paragraph).
- **Cancel check per step:** `runStep` calls `pipelineRepo.heartbeat` before starting (one UPDATE;
  also detects a scan taken over elsewhere). Remaining window: a cancel arriving while the last
  step runs cannot interrupt that step if it ends before the next heartbeat.
- **Paging large lists:** findings page 100 per page; the page of a linked finding comes from the
  ordered display ids (`listFindingDisplayIds`, cheap). The findings **API** still returns all
  findings (unchanged contract; 7 MB for 6,625 findings). Compare page: 50 per category on the
  overview, 200 per page per category; the comparison itself (and the API, 4.7 MB for 3,750
  issues) is unchanged.
- **Dependency audit (2026-10-09, `npm audit`):** production tree 7 moderate (mammoth → argparse →
  sprintf-js, used by mammoth's CLI only; esbuild dev-server advisory via drizzle-kit, not run in
  production); dev tree adds 5 high / 2 critical in ESLint's Next plugin (fast-glob → micromatch →
  braces) and `concurrently` (shell-quote; only quotes the repo's own script names). Offered fixes
  are breaking downgrades; nothing was changed — a decision for the owner.
- **Performance data** was generated in `qa_copilot_test` by cloning a real scan's issues 124×
  (3,750 tracks, 6,625 findings, 9,250 evidence rows) plus a second real scan; numbers in
  `PROJECT_STATUS.md` → Phase 16 are local measurements on this Windows machine, not benchmarks.

## Issue explanations (Phase 15 extension, 2026-10-11)
- **One shared guide, built at render time.** `packages/core/src/fix-guide.ts`
  (`@qa/core/fix-guide`, pure, browser-safe) turns a stored occurrence plus its findings'
  evidence into: plain summary (problem / why it matters / next action), facts recorded by the
  scan, numbered fix steps, before/after code examples, caveats, verification steps and "what the
  scan could not tell". Built when the page renders, so all existing issues (no re-scan) get it.
  Used by the issue page, the scan's issue list (compact summary) and all report formats.
- **Grounding of the guide:** wording per rule is fixed text; every page, element, HTML snippet,
  header, URL and measurement is read from the evidence. "Before" code is either copied from the
  evidence (`observed`: axe `html`, `html_snippet`, `link_check.linkedFrom[].html`, recorded
  header values) or a minimal form built from evidence values (`illustrative`). "After" code is
  produced by small attribute edits on the recorded tag (`withAttribute`) and never completes a
  truncated tag. What the scan cannot know (what an image shows, the page language, the right
  link target, a cookie's value) is a `[placeholder]`. The only computed value is the
  contrast-safe color (WCAG formula, labelled "calculated"). A unit test asserts that no guide
  contains a URL that is not in its input (allowed: placeholders and the `https://schema.org`
  JSON-LD vocabulary id).
- **Context instead of one fix for everything:** image-alt offers informative / decorative /
  only-content-of-a-link-or-button variants; the last is highlighted only when the selector shows
  an `a`/`button` ancestor or the class name contains icon/nav/menu/button/logo words (phrased as
  a hint). Platform tips (WordPress, Next.js `<Image>`, Shopify) appear only when the recorded
  HTML or URLs show the platform. Header facts appear only for headers the evidence actually
  recorded (`csp-unsafe-script` stores the directive, not the header — it is never reported as
  "not sent"; frame protection reads `x-frame-options`). Cookie values are masked as `[value]`.
  Links distinguish broken / temporary / redirect and warn that 401/403/429/999 may be bot
  blocking. Performance facts are only the stored lab values and thresholds, with a lab caveat.
  Security guides always state that a missing protection is not evidence of an attack.
- **Coverage:** rule-specific guides for every rule the security, SEO, links, performance and
  responsive scanners emit (asserted in `grouping.test.ts` against the emitted-rules list), for
  design and content comparison, and for 23 common axe rules. Other axe rules use a general guide
  built from the stored catalog guidance plus the axe evidence (WCAG criterion, impact, axe's own
  summary, rule documentation link) and say that no rule-specific guide exists.
- **Uncertain verdicts:** for potential / inconclusive issues the next action starts with "First
  check whether the problem is real" and the gaps list the verdict meaning.
- **Verification never marks anything fixed:** the steps end with a new scan and say that
  marking an issue Resolved does not verify it; copying code only writes to the clipboard.
- **AI explanation (optional, grounded):** the AI output schema gained `explanation`
  (`problem`, `impact`, `nextStep`, `steps[]`, `caveats[]`). Parsing accepts it missing
  (`nullish`) so older responses and models still work; the JSON schema sent to providers
  requires it (nullable), because strict structured output needs every property listed.
  Grounding runs the existing fact check per part: problem/impact/nextStep individually; steps
  all-or-nothing (a partial list would read as complete); caveats one by one. Unsupported parts
  are dropped and the built-in guide is shown for them; every check is stored (`field:explanation.*`)
  and shown under Evidence validation. Code examples are never AI-written (the prompt says so and
  the UI never renders AI code). The UI uses AI parts only when the issue's grounding status is
  `passed` or `partial`, and labels them. `PROMPT_VERSION` `issues-2026-10-11-explain`.
- **Storage:** nullable `issue.explanation jsonb` (migration `0009_issue_explanation`, additive).
  Applied to the development database on 2026-10-11 after a `pg_dump -Fc` backup
  (`qa_copilot_before_0009.dump`, 11.4 MB, session scratchpad); row counts unchanged.
- **Output budget:** live Gemini runs used about 300–450 output tokens per issue; the explanation
  adds an estimated 300–400, so a 10-issue batch stays well under `AI_MAX_OUTPUT_TOKENS=16000`. A
  truncated batch fails safely (its issues keep the scanners' wording). Not yet measured live.
- **Findings page (added after user feedback, 2026-10-11):** the user tested on the scan's raw
  findings page, which still showed only scanner output. `FindingGuide` renders the guide for one
  raw finding (category = the finding's scanner, no AI text — raw findings never carry any);
  `LazyFindingGuide` (client) builds it when the row's `<details>` opens, because server-rendering
  every guide doubled the page (1.56 MB vs 0.77 MB for 57 findings). Screenshot evidence is not
  passed to the client. The technical block is a nested, closed `<details>`.
- **Two levels on the issue page:** Level 1 cards (In plain language, Where it was found, How to
  fix it, Example fix, How to verify the fix); Level 2 is a `<details id="technical">` holding
  the unchanged technical cards plus "How reliable". It is closed by default and opens itself for
  a `#fragment` inside it (`#evidence` links keep working).

## Workflow redesign and Design Quality & Typography scanner (2026-10-13)
Request: brand guidelines and font files in the first wizard step; content documents and multiple
page links in "Figma / brand"; remove the separate Content step; a new selectable scanner
"Design Quality & Typography" integrated across the whole scan lifecycle.

- **Wizard** (`apps/web/src/app/(app)/projects/new/project-wizard.tsx`): five steps instead of
  six — Project (name, website URL, brand guidelines [multi-file, ≤ 10], font files [≤ 20]) →
  Figma / brand (Figma design URL, hand-entered design values, content documents with page
  mapping, Page links with "+ Add page") → Configure scan → Review → Start scan. The old "Content"
  step's code was moved, not hidden: same file validation, same `content-documents` API, same
  per-file page mapping (now with a datalist of the added page links), same processing status on
  the last step. No other part of the app used the step (the project area never had a Content tab;
  its References page keeps the content panel).
- **Uploads before the project exists:** files are only selected (validated in the browser) until
  "Create project". The project is created first (with page links in the same request), then each
  file is uploaded with real progress (`apiUploadWithProgress`, XMLHttpRequest upload events) and
  its own status (waiting / uploading n% / uploaded / failed + Retry). If creation fails nothing
  is stored and every entry and file stays in the form. Uploading before creation would need
  orphan-file cleanup; the existing "create, then attach" pattern was kept.
- **Page links:** table `project_page_link` (unique per project on a duplicate key = host without
  `www.`, path without trailing slash, sorted query). Validation (`@qa/core/page-links`,
  browser-safe, plus `validateWebsiteUrl` SSRF rules on the server): http(s), same site as the
  project (as the crawler defines it), no credentials, not a Figma link, not a file. API
  `GET/POST /projects/:id/page-links`, `DELETE …/:linkId`; `POST /projects` accepts `pageLinks`
  (all-or-nothing: an invalid link rejects the request, errors at `pageLinks.<n>`). Scans freeze
  the URLs into `configSnapshot.pageLinks`; the crawler visits them right after the start page as
  `seed` items, outside `maxPages`/`maxDepth`, still subject to robots.txt and the network guard;
  stored pages get `page.origin = 'user'` (others `'crawl'`); the crawl step's reason lists how
  many loaded and each failure ("…/no-such-page – HTTP 404"); the Pages list marks them "Your
  page link". Page links are **not mapped to Figma frames**: the design reference is a set of
  values (tokens), not page layouts, so no correspondence is claimed; this is stated in the UI.
- **Brand fonts:** table `project_font` (unique per project on sha256). `@qa/security/font`
  validates extension, declared MIME type and file signature (`0x00010000`/`true`, `OTTO`, `wOFF`,
  `wOF2`; `ttcf` collections refused), then reads the tables with bounds checks: WOFF tables are
  inflated with `maxOutputLength`, WOFF2 is Brotli-decompressed with `maxOutputLength` (directory
  with UIntBase128 lengths and the glyf/loca null-transform rule), `head` magic must be valid,
  `name` (families 1/16, styles 2/17, full name 4, PostScript 6, version 5; Windows English
  preferred), `OS/2` weight, fsSelection italic and fsType embedding bits, `maxp` glyph count,
  `fvar` = variable font. A row exists only when this succeeded, so there is no "uploaded but not
  processed" font state. Limit 10 MB (or `MAX_UPLOAD_MB` if lower). Fonts are never served or
  injected into scanned pages; scans freeze only the names (`configSnapshot.approvedFonts`).
  Verified on real files: Geist TTF and WOFF2 (Next.js, OFL), Arial, Segoe UI Variable.
- **Duplicate uploads:** the same bytes cannot be uploaded twice to one project as a content
  document, brand guideline or font (409 naming the existing file) — protects against a retried
  wizard upload creating duplicate records.
- **Scanner key `design_quality`** in `SCANNER_KEYS` (selectable in the wizard and project
  settings, default on for new projects; existing projects keep their saved selection). It is a
  "late" scanner (`LATE_SCANNERS` in `@qa/core/pipeline`): planned and run after the design and
  content comparisons and before `ai`, because it reads their stored results
  (`ScannerContext.stepResult`).
- **Capture:** when the scanner is selected, every capture runs `DESIGN_QUALITY_SCRIPT`
  (`packages/browser/src/quality-scripts.ts`, read-only): visible H1–H6 with computed font
  family/size/weight/style/line height, whether inside header/nav/footer; ≤ 20 body paragraphs;
  `document.fonts` faces with status; images with intrinsic/rendered size, object-fit, SVG/broken;
  stacked sibling left edges; runs of ≥ 3 consecutive same-kind siblings (tag + first class) and
  their gaps; margins/paddings/gaps used. At the widest viewport it also asks Chromium which fonts
  rendered a sample of headings/paragraphs (`collectRenderedFonts`: DevTools
  `CSS.getPlatformFontsForNode` on the element holding the first text). Stored as
  `…/<viewport>.quality.json`, key in `page_capture.quality_key`.
- **Checks and verdicts** (`packages/scanners/src/design-quality.ts`, rule ids `dq-*`):
  - Heading consistency: same level, same screen size, different family/size(±0.5px)/weight/style
    → potential (low). Chrome headings excluded (noted). Never compares across screen sizes.
  - Visual hierarchy: median size of a lower level > a higher level on the same page/screen size
    → potential (low); the semantic outline stays with the accessibility scanner.
  - Reference values: **not recompared.** Heading values of the confirmed design spec (brand
    guideline values after confirmation, Figma values after confirmation, manual values) are
    compared by the design comparison; the scanner copies those items (with the reference source)
    into its comparison table and says the finding is under Design comparison. Levels without a
    reference value are listed as "unable to verify" with the observed sizes; no expected size is
    ever invented. Design step failed → part "not available", scanner inconclusive.
  - Web font rendering: declared first family (non-generic) has `@font-face` faces but the font
    engine drew another font → confirmed (medium). A non-web font missing on the scan machine is
    an inconclusive check, not a finding (it depends on the visitor's device). Skipped when the
    design comparison already reported the same family as "web font failed to load".
  - Uploaded brand fonts: headings/body whose first family is not one of the fonts' names →
    potential (low); per font a comparison item: rendered (verified by the font engine) / declared
    but fallback drawn / declared, not verifiable / not used.
  - Images (visible, ≥ 48px, not SVG, not broken): displayed scale by object-fit (fill/cover =
    max axis, contain = min, scale-down ≤ 1, none = 1) ≥ 1.5 → confirmed (medium at ≥ 2),
    1.15–1.5 → potential; fill with aspect change > 5% → confirmed stretched. Measured at device
    pixel ratio 1; blur/compression are explicitly not assessed. Broken images and alt text stay
    with responsive/links/accessibility (noted, not repeated).
  - Spacing: only with an explicit `spacing.scale` in the confirmed spec — off-scale values
    (±0.5px) at the widest viewport → one potential finding with counts. Near-miss alignment
    (stacked blocks 1–4px apart) and uneven gaps (> 2px spread in a run of ≥ 3 same-kind siblings)
    → potential (low), at most 10 each. "Against design frames" is always an inconclusive check
    (no page-to-frame mapping exists).
  - Approved content: **not recompared.** Not configured when the scan has no processed content
    document; otherwise the content comparison's counts are reported; failed/inconclusive content
    step → part failed/not available.
  - Status: `checks.parts` lists each part as completed / not configured / not available / failed
    / inconclusive. Any failed or not-available part → step **inconclusive** with
    "Partially completed … Completed: … Not available: …"; no measurements at all → inconclusive.
- **Explanations / fixes:** every `dq-*` rule has a plain-language explanation
  (`explain.ts`), a fix guide with steps, illustrative code with [placeholders] and verification
  (`fix-guide.ts`), and catalog guidance for AI/deterministic issue text (`ai/catalog.ts`).
- **Results UI and reports:** scanner results and the scan's comparison page show the parts and
  the comparison table; Pages list has a Design quality column; reports list the parts per step.
  Issues, history comparison, AI and grounding treat `design_quality` like any other category.
- **Migration `0010_design_quality`** (additive): `project_page_link`, `project_font`,
  `page.origin varchar(16) default 'crawl'`, `page_capture.quality_key`. Applied to the development
  database on 2026-10-13 after a `pg_dump -Fc` backup (`qa_copilot_before_0010.dump`, session
  scratchpad); row counts unchanged (20 projects, 19 scans, 1 098 pages, 14 003 findings, 471
  issues).

## Environment facts
- PostgreSQL 18 binaries: `C:\Program Files\PostgreSQL\18\bin` (not on PATH). Service `postgresql-x64-18`.
- No Docker, no Redis, no pnpm. Windows 11, Node 22.16.
- Project folder: `C:\Users\Siddharth\Downloads\qa-copilot`.
- Agent sessions: creating the Phase 6–8 checkpoint commits with `git commit-tree` +
  `git update-ref` (Phase 9 session) made the auto-mode permission classifier block several plain
  file reads afterwards ("Git Destructive"). Use ordinary `git add`/`git commit` for checkpoints.

## Unfinished tasks
- All planned phases (0–10 and enhancement Phases 11–16) are implemented; Phases 11–16 are
  **uncommitted**. Not verified in this environment: the Docker image/Compose stack (no Docker),
  live AI providers and the live Figma API (no keys or token), OS signal handling of the worker on
  Linux (Windows cannot deliver SIGTERM to a Node process; the shutdown logic itself is covered by
  integration tests), OCR for image-only PDF pages (not implemented).
- Owner decisions open: commit Phases 11–16; dependency advisories (see Phase 16 decisions);
  a separate e2e database (needs the PostgreSQL superuser; `qa_copilot_test` was used instead).

## Known bugs
- None known. Remaining limits (by design, documented): a cancel arriving while the last scan step
  runs cannot interrupt that step; the findings API and the comparison API return complete lists
  (several MB for thousands of items); guideline values read from a merged paragraph cite the
  paragraph's first line. Known log noise: "The destination stream closed early" from
  `next start` when an e2e test leaves a page while a streamed response is in flight
  (timing-dependent, harmless).

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
