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
- Scanners deterministic and evidence-first; AI only groups/explains; grounding deterministic.
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

## Environment facts
- PostgreSQL 18 binaries: `C:\Program Files\PostgreSQL\18\bin` (not on PATH). Service `postgresql-x64-18`.
- No Docker, no Redis, no pnpm. Windows 11, Node 22.16.
- Project folder: `C:\Users\Siddharth\Downloads\qa-copilot`.

## Unfinished tasks
- None inside Phase 6. Next: Phase 7 (after approval).

## Known bugs
- None known.

## Commands to resume
```bash
git status && git log --oneline
npm install
npm run typecheck && npm run lint && npm test
npm run db:check
npm run db:migrate
npm run dev            # web + worker (the worker also processes documents and Figma)
npm run demo:site      # fixture website on http://localhost:4100
npx playwright test    # after `npm run build`; stop stale servers on 3100/3191 first
```
Read `PROJECT_STATUS.md`, this file and `docs/ARCHITECTURE.md` first.
