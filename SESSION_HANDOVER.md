# Session Handover

_Last updated: 2026-10-13 (workflow-redesign + Design Quality scanner session; see §0). Written
from the repository, the git history, the project documents, the Claude Code project memory,
read-only database queries and test runs. Earlier Claude conversations are **not** available to a
new session; nothing below is recalled from them._

## 00. Session 2026-10-14: manager demo package
- Added `fixtures/manager-demo/` (read `DATA_MANIFEST.md` there first): a fictional "Brightline
  Studio" demo website (`npm run demo:manager`, port 4100 because `.env` allows only
  `localhost:4100` for local scanning; the old `npm run demo:site` must be stopped first), brand
  guidelines (Markdown, extractor-compatible), optional full design-values JSON, real Geist font
  files (OFL 1.1, licence included), approved-content Markdown with page markers, a Figma-ready spec
  (no demo Figma file exists; the user's real Ascendion_Dev link is documented with its limits),
  `END_TO_END_TEST_GUIDE.md`, `MANAGER_DEMO_SCRIPT.md`, `verify-demo-site.mjs`
  (`npm run demo:manager:check`). The site has a `fixed` variant (`POST /__demo/variant`) for the
  re-scan demo. Existing fixtures and tests were not changed.
- Verified 2026-10-14 on the isolated stack (prod build :3200, worker :3291, test DB, AI/Figma off,
  demo site on :4199): project with 5 page links + guideline + 2 fonts + content via the real API;
  draft confirmed; scan #1 all steps Completed (AI skipped), 42 findings → 38 issues, every
  documented defect found; fixed-variant scan #2: comparison 9 resolved / 28 persistent / 1 changed;
  Markdown report generated. Unit tests 540/540; lint/Prettier clean (except `.claude/launch.json`).
- Figma: token is recognised (`GET /v1/me` → 403 "Invalid scope", scopes file_content:read +
  file_metadata:read); the Ascendion_Dev file was not re-read (quota). Not done: a UI-driven
  walkthrough of this specific package (the UI flows were verified on 2026-10-13), a live AI scan.

## 0. Session 2026-10-13: workflow redesign and Design Quality & Typography scanner

**How history was recovered (verified sources only):** `git status`/`git log`/`git diff --stat`
(branch `main`, HEAD `8365d1e`, 108 tracked files modified + ~50 untracked from Phases 11–16 and
the 2026-10-11 issue-explanation work, all uncommitted), this file, `ENHANCEMENT_BASELINE.md`,
`PROJECT_STATUS.md`, `IMPLEMENTATION_NOTES.md`, `CHANGELOG.md`, the Claude Code project memory
(`enhancement-programme.md`), and the source code. No `CLAUDE.md`/`AGENTS.md` exist. The previous
session's launcher script for isolated test servers still exists in its scratchpad (referenced by
`.claude/launch.json` → `fulltest-*`). Earlier conversations themselves are not accessible.

**Protection of existing work:** before any edit the working tree was backed up to this session's
scratchpad (`backup/tracked.patch` = `git diff --binary`, `backup/untracked.tar`). No reset, no
commit, no push.

**Request (user, 2026-10-13) and verified starting point:**
- The "tabs" named in the request are the steps of the New Project wizard
  (`apps/web/src/app/(app)/projects/new/project-wizard.tsx`): *Project → Figma / brand → Content →
  Configure scan → Review → Start scan*. The project area itself has no Content tab (its
  References page shows design + content panels together).
- Before this session: brand guideline upload (one file) lived in "Figma / brand"; content
  documents (multi-file, optional page mapping) in "Content"; no font uploads; no page-link
  concept (the crawler discovers pages from the start URL only); six scanners
  (`SCANNER_KEYS`) plus automatic design/content comparisons when references exist.
- Heading typography against a reference was already compared by the **design comparison**
  (`packages/scanners/src/design.ts`, role-level, only with a *confirmed* design spec); approved
  content by the **content comparison** (`packages/scanners/src/content.ts`); broken images by the
  responsive scanner; missing alt text by accessibility.

**Plan (decisions):** see `IMPLEMENTATION_NOTES.md` → "Workflow redesign and Design Quality &
Typography scanner (2026-10-13)" for the final record. In short: wizard steps become *Project
(name, URL, brand guidelines, font files) → Figma / brand (Figma link, manual values, content
documents, page links) → Configure scan → Review → Start scan*; fonts and page links get their own
tables (migration 0010) and API; page links are crawled as user-selected pages and stored with
`origin = 'user'`; the new scanner `design_quality` runs after the reference comparisons,
reuses their results by cross-reference instead of duplicating findings, and adds its own
evidence-backed checks (heading consistency/hierarchy, web-font rendering, approved fonts,
image upscaling/distortion, spacing/alignment).

**Result (verified in this session):**
- Implemented as planned; file-level record in `IMPLEMENTATION_NOTES.md` → "Workflow redesign and
  Design Quality & Typography scanner (2026-10-13)" and `CHANGELOG.md`.
- **Migration `0010_design_quality`** applied to the dev DB `qa_copilot` (now 11 migrations) after
  `pg_dump -Fc` → `backup/qa_copilot_before_0010.dump` (11.6 MB, this session's scratchpad); row
  counts identical before/after (20 projects, 19 scans, 1 098 pages, 14 003 findings, 471 issues).
  The user's own `next dev` (:3000) and worker (:3001) were checked healthy afterwards.
- **Test results 2026-10-13:**
  - Baseline before edits: typecheck ✓, ESLint ✓, vitest 641/643 — 2 failures in
    `references-api.int.test.ts` (first test hit the 30 s timeout under load, second failed as a
    consequence); the file passed 5/5 when rerun alone → pre-existing load flake, not a defect.
  - Final: typecheck (root + all workspaces) ✓; ESLint ✓; Prettier ✓ except the pre-existing
    `.claude/launch.json` warning; **vitest 678/678** (69 files: 540 unit, 138 integration on
    `qa_copilot_test`; +35 new: 8 font, 5 page-link/plan, 2 crawler, 14 scanner, 5 API, 1 real
    Chromium pipeline); `next build` ✓; **Playwright e2e 10/10** on `qa_copilot_test` (AI and Figma
    off). Two existing assertions changed on purpose (new projects default to 7 scanners) and
    three e2e expectations for the 5-step wizard / renamed "Figma design URL" label.
  - A real measurement bug found by the pipeline test was fixed (gaps were measured across a
    sibling of another kind: "16px, 84px" → now runs of consecutive same-kind siblings).
  - Browser walkthrough (production build :3200 + worker :3291 + private fixture site :4199, test
    DB, AI/Figma off, throwaway account `dq-walkthrough@example.test`): full wizard with a brand
    guideline, a synthetic test font, a content document mapped to `/design-quality`, page links
    (other-site, duplicate and `.pdf` attempts rejected with messages; one removed); uploads showed
    Uploaded with the font family read from the file; References page showed draft values, the
    font and both page links after reload; duplicate and fake font uploads showed Failed + Retry;
    a scan (Responsive + Design Quality, confirmed guideline reference H1 = 40px) completed: page
    links visited beyond the 3-page limit, `/no-such-page` reported as HTTP 404 and marked "Your
    page link"; Design Quality completed with 11 findings and all six parts "Checked"; comparison
    page showed H1 40px = 40px (from `brand-guide.md, line 5`) and H2/H3 "Unable to verify";
    issue ISSUE-4 (web font fallback, rendered with Georgia, status "error") showed the
    plain-language guide; Markdown report lists the step and its parts. 375 px: no horizontal
    scroll. Console: only the two deliberate 409/400 upload responses; no server errors.
- **Known limitations / not done:**
  - Rendered-font checks run at the widest viewport only (≤ 12 headings + 2 paragraphs per
    capture); a font missing on the scan machine is reported as inconclusive, not as a defect.
  - Image clarity = intrinsic vs displayed size at 1× pixel density and aspect ratio; no blur,
    compression or pixel analysis; high-density (2×) needs are mentioned, not reported.
  - Spacing/alignment are heuristics (potential findings); no comparison with Figma frames
    (no page↔frame mapping exists — stated in the UI and as an inconclusive check).
  - Heading reference values come only from the *confirmed* design spec; brand-guideline values
    stay a draft until confirmed (existing workflow).
  - Existing projects keep their saved scanner selection (Design Quality off until enabled in
    project settings); new projects have it on.
  - Upload rate limit (30 uploads / 10 min per user) also applies to wizard uploads.
  - Live Figma and live AI were not exercised in this session (credentials exist in `.env`, but
    test servers ran with AI/Figma off to preserve quotas); only mock/integration tests cover them.
  - In the walkthrough, one programmatic click on the existing "Confirm draft" button (made while
    the page was still streaming) did not register; the draft was then confirmed through the same
    API the button calls. The button was not changed in this session and was not investigated
    further (the e2e suite, which clicks it normally, passes).
- **Precautions kept:** no commit, push, reset or deletion; `.env` untouched; e2e/browser runs only
  on `qa_copilot_test` (env overrides via `run-e2e.mjs` / `start-isolated.mjs` in the scratchpad);
  `.claude/launch.json` `fulltest-*` entries now point at this session's launcher, plus a
  `fulltest-demo` entry (private fixture site on :4199). All test servers were stopped.

Read order for a new session: this file → `ENHANCEMENT_BASELINE.md` (programme rules, audit) →
`PROJECT_STATUS.md` → `IMPLEMENTATION_NOTES.md` → `docs/ARCHITECTURE.md`.

## 1. Purpose and architecture
QA Copilot is an AI-assisted website QA, design and brand-compliance platform. A user creates a
project with the **live website URL**, optionally a **Figma file link** and/or **brand guideline**
(how the site should look) and **approved content documents** (what it should say). Scans crawl
the site, capture it in Chromium at several viewports, run six evidence-producing scanners
(accessibility, security, SEO, links/mixed content, performance, responsive/visual), compare with
the confirmed design reference and approved content, group findings into tracked issues, let AI
(optional) write grounded issue text, explain every issue in plain language with a fix guide, and
produce history comparisons and reports.

TypeScript npm-workspaces monorepo: `apps/web` (Next.js 16 UI + `/api/v1`, Better Auth),
`apps/worker` (scan / reference+document / report loops), PostgreSQL 18 as database **and** job
queue, local `storage/`. Packages: `core`, `db`, `security`, `storage`, `crawler`, `browser`,
`scanners`, `reference`, `ai`, `reports`. Details: `ENHANCEMENT_BASELINE.md` §4,
`docs/ARCHITECTURE.md`.

## 2. Completed phases and evidence
| Phase | State | Evidence |
|---|---|---|
| 0–10 | Committed | Commits `8f25017` … `8365d1e` (HEAD, "Phase 10: production hardening") |
| 11 Baseline | Done, approved 2026-10-09 | `ENHANCEMENT_BASELINE.md`; 506/506 vitest at the time |
| 12 Free-tier LLM | Done, approved 2026-10-09 | `LLM_PROVIDER_SETUP.md`; 537/537 vitest |
| 13 Large documents | Done, approved 2026-10-09 | `LARGE_DOCUMENT_PROCESSING.md`, migration 0007; 572/572 |
| 14 Figma multi-page | Done; treated as approved by the user's 2026-10-09 instruction to continue | `FIGMA_INTEGRATION.md`, migration 0008; 595/595 |
| 15 UI/UX + plain-language issues | Done, approved 2026-10-09 | §3 |
| 16 Final validation | Done 2026-10-09 — **awaiting approval** | `PROJECT_STATUS.md` → Phase 16 results |
| Live AI / Figma enablement | Done 2026-10-10 | `LLM_PROVIDER_SETUP.md` §0, `FIGMA_INTEGRATION.md` §0 |
| 15 extension: human-friendly issue explanations | Done 2026-10-11 — **awaiting review** | §3a, `PROJECT_STATUS.md`, migration 0009 |

## 3. Existing capabilities (verified in code)
- **Scanners:** axe-core accessibility + keyboard-focus check; passive security (transport,
  headers, cookies, forms, SRI, exposed secrets); SEO (titles, descriptions, headings, robots,
  canonical, lang, viewport, sitemaps, structured data, Open Graph, duplicates); links (broken
  internal/external with temporary vs broken, redirects, failed resources, mixed content); lab
  performance (LCP, CLS, TBT, TTFB, FCP, weight, JS/CSS size, requests, images, render
  blocking); responsive (overflow, clipped text, overlap, tap targets, small text, broken images,
  mobile nav). Every finding has zod-validated evidence (`packages/scanners/src/types.ts`).
- **AI:** providers `gemini`, `groq`, `anthropic`, `openai-compatible`, `none`; batched
  structured output; deterministic grounding (`packages/ai/src/grounding.ts`); rate-limit pacing;
  deterministic fallback with rule-catalog guidance (`packages/ai/src/catalog.ts`).
- **Figma:** official REST API, multi-page batching, manifest, checkpoint/resume
  (`FIGMA_INTEGRATION.md`). **Documents:** large PDF/DOCX/TXT/MD extraction with checkpoints,
  sections and full-text search (`LARGE_DOCUMENT_PROCESSING.md`).
- **Issues:** deterministic grouping into tracked issues (`ISSUE-n`), audited status workflow,
  reopen rule, history comparison, reports (Markdown, PDF/HTML, JSON).

## 3a. Issue explanations (this session, 2026-10-11)
Previous state (Phase 15): an "Explanation" card on the issue page with fixed per-rule wording
(`packages/core/src/explain.ts`: meaning, impact, manual check) plus stored facts; fix text was
the stored recommendation; specific catalog fixes for 11 axe rules.

Implemented now (details: `IMPLEMENTATION_NOTES.md` → "Issue explanations"):
- `packages/core/src/fix-guide.ts` (`@qa/core/fix-guide`): builds a guide per occurrence at render
  time from the stored issue and its findings' evidence — summary (problem / why / next action),
  recorded facts, numbered steps, before/after code (copied from evidence or labelled
  illustrative; placeholders in [brackets] for what the scan cannot know), caveats, "what the
  scan could not tell", verification steps ending with a re-scan. Rule-specific for every
  security, SEO, links, performance and responsive rule, design/content comparison and 23 axe
  rules; general guide otherwise. Works for all existing issues without a re-scan.
- Issue page (`apps/web/src/app/(app)/projects/[id]/issues/[issueNo]/page.tsx`,
  `components/issues/plain-explanation.tsx`, `copy-button.tsx`, `technical-disclosure.tsx`):
  Level 1 cards In plain language / Where it was found / How to fix it / Example fix / How to
  verify the fix; Level 2 collapsible "Technical details and evidence" with every earlier
  technical card plus "How reliable". Sidebar (status, history, occurrences) unchanged.
- Scan issue list: compact plain summary + link to the guide. Reports: plain-language block.
- Scan **Findings** page (raw findings, e.g. `A11Y-024`): same guide per finding, built in the
  browser when the finding is opened (`components/issues/lazy-finding-guide.tsx`); technical
  output in a collapsible section. Added after the user tested that page and saw no change.
- AI: optional `explanation` in the AI output (`packages/ai/src/schema.ts`), grounded per part
  (`grounding.ts`), prompt `issues-2026-10-11-explain`, stored in `issue.explanation`
  (migration `0009_issue_explanation`), labelled in the UI; AI never writes code examples.

## 4. Git status
- Branch `main`, HEAD `8365d1e`. **Nothing from Phases 11–16, the live enablement or this
  session is committed**; no commit or push was made. `git status` lists ~100 modified tracked
  files and the untracked new files (including `docs/QA-Copilot-Architecture.pdf` from before
  Phase 11).
- Backup of the working tree taken at the start of this session (outside the repo, session
  scratchpad): `backup/tracked.patch` (git diff --binary) and `backup/untracked.tar`.

## 5. Tests
- **Start of this session (before edits):** typecheck, ESLint clean; Prettier clean except
  `.claude/launch.json` (pre-existing, local tool config); unit 480/480 (42 files).
- **End of this session (final code):** typecheck, ESLint clean; Prettier as above; unit
  **511/511** (43 files); integration **132/132** (22 files, run before the findings-page
  follow-up, which touches no server code); `check:tsx-capture` pass; `next build` pass;
  Playwright e2e **10/10** (after the follow-up). Browser walkthrough on a fixture scan (32 issues,
  all six categories): see `PROJECT_STATUS.md`.
- Known limitations: no live AI call was made for the new explanation field (quota preserved;
  unit-tested only; output-token use estimated, not measured); screenshots/clipboard success not
  verified because the Browser pane was hidden; accessibility rules other than the 23 guided ones
  use the general guide.

## 6. Next step
**2026-10-13:** waiting for the user's review of the workflow redesign and the Design Quality &
Typography scanner (§0). Earlier: waiting for the user's review of the issue-explanation work. Open owner decisions: approve this
work and Phase 16; whether and how to commit (suggested: one commit per phase, or a single
"Phases 11–16 + issue explanations" commit); dependency advisories; a separate e2e database;
optionally one live AI scan to see the new explanation field (costs ~2–4 of the 20 daily Gemini
requests).

## 7. Precautions
- **Databases:** `qa_copilot` holds real user data — never reset, truncate or run e2e/smoke against
  it. It is at **11 migrations** (0010 applied 2026-10-13, see §0; 0009 applied 2026-10-11 after `pg_dump -Fc` backup
  `qa_copilot_before_0009.dump` in the session scratchpad; counts unchanged: 434 issues,
  386 tracks, 13,673 findings, 18 scans). `qa_copilot_test` is disposable and truncated by
  integration tests. The app role cannot create databases, so e2e and browser checks run on
  `qa_copilot_test` by overriding `DATABASE_URL` (plus `STORAGE_DIR`, test `ENCRYPTION_KEY`) in
  the process environment — **the e2e helpers load `.env`, so without the override they would
  touch the development database.** Never run integration tests while servers on the test
  database are running.
- **Environment:** `.env` is the user's; never replace it or print its secrets. Since 2026-10-10
  **AI is live** (`AI_PROVIDER=gemini`, `gemini-3.6-flash`, free tier ≈ 20 requests/day) and a
  **Figma token is set** (viewer seat: very few file reads per month). For every test server set
  `AI_PROVIDER=none` and `FIGMA_ACCESS_TOKEN=` (empty) in the process env, as this session did.
- **Running processes:** the user's own `next dev` (:3000), worker (:3001, `tsx watch` — it
  restarts when package code changes) and demo site (:4100) stay untouched. Test ports: 3200/3291
  (browser, `.claude/launch.json` → `fulltest-web` / `fulltest-worker`, launcher script in the
  session scratchpad) and 3100/3191 (e2e). Stop your own test servers at the end of a session.
- **Next 16 builds:** `next build` writes `.next/`; `next dev` uses `.next/dev`.
- **Line endings:** files are LF. Python text-mode writes on Windows produce CRLF — write bytes.
- No commits without explicit authorization; phases wait for `APPROVED — CONTINUE`.
