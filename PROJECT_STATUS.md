# Project Status: QA Copilot

_Last updated: 2026-10-04_

## Completed phases
- **Phase 0: Requirements & Architecture.** Approved 2026-10-03.
- **Phase 1: Project Foundation.** Approved 2026-10-03.
- **Phase 2: Database + Project Management.** Approved 2026-10-03.
- **Phase 3: Dashboard / UI.** Approved 2026-10-03.
- **Phase 4: Crawler + Playwright.** Approved 2026-10-03 (open issues fixed in "Fix Phase 4 open issues").
- **Phase 5: Six QA scanners.** Verified complete on 2026-10-04 before Phase 6 started
  (typecheck, lint, format clean; 249/249 tests).

## Current phase
**Phase 6: Figma/brand references, content documents, design and content comparison.**
Implemented and verified. **Awaiting approval ("APPROVED — CONTINUE").** Phase 7 not started.

## Blockers found and fixed at the start of Phase 6
- `packages/storage` had never been committed: `.gitignore` pattern `storage/` also matched
  `packages/storage/`, so a fresh clone could not build. Fixed by anchoring it to `/storage/`
  (also in `.prettierignore`); the package is now visible to git and formatted.
- The setup wizard's last step still showed a disabled "Start QA Scan" with Phase 3 wording; it
  now uses the real Start QA Scan control. The Scan page's "scanners are added in Phase 5" note
  was also stale and has been corrected.

## Phase 6 features implemented
- **DesignSpec** (`@qa/core/design-spec`): typography roles (h1–h6, body, link, button), palette
  colors with optional website roles, primary/secondary buttons, container width, spacing scale,
  optional CSS selectors and scope; **provenance on every token** (Figma node, document
  page/line/excerpt, or manual). Versioned in `design_spec`; drafts vs confirmed versions.
- **Figma** (`packages/reference`): REST client (fixed host, `X-Figma-Token`, 50 MB cap, mapped
  401/403/404/429 errors), normalizer for local text/color styles, Button components
  (Primary/Secondary variants, default state preferred) and a "Container" frame. Token from
  `FIGMA_ACCESS_TOKEN` or a per-project token stored encrypted (write-only API/UI). Without a
  token the reference is "Unavailable" with guidance; nothing is invented.
- **Brand guideline extraction**: deterministic, literal values only (hex/rgb colors with labels,
  font declarations, size/weight/line-height lines), each cited; result is a draft.
- **Draft workflow**: extracted values merge into one pending draft (manual values never
  overwritten); review table with every change and its source; confirm/discard; manual saves are
  refused while a draft is pending. Scans freeze the confirmed version (`scan.design_spec_id`).
- **Content documents**: upload (PDF/DOCX/TXT/MD, `MAX_UPLOAD_MB`), validation (extension +
  declared MIME + magic bytes, UTF-8, DOCX zip-bomb guard via the central directory), random
  storage keys; parsed by the worker into blocks (headings with levels, paragraphs, list items,
  links, CTAs with targets) with locations (PDF page, line, heading path) and page markers
  (`Page:` / `URL:` / `<!-- page: -->`). PDF headings recovered from font sizes; image-only PDFs
  fail with "no OCR". Page mapping per document; retry; delete. Scans freeze the parsed documents.
- **Reference worker loop** in the worker process (separate from scans; LISTEN + polling; stale
  jobs failed with a retry hint on start).
- **Capture**: computed styles of design roles + palette + web-font status (all viewports) and
  visible text blocks/links (widest viewport), only when the scan has references.
- **Design comparison**: explicit selector > semantic HTML > class heuristics (confidence);
  CIEDE2000 colors (≤ 2 match, 2–5 potential, > 5 mismatch), ±0.5px sizes, exact weights, first
  declared font family (+ failed web fonts); size-dependent values at the widest viewport by
  default; one finding per token aggregated across pages/viewports; palette near-misses
  (potential); roles present on the site but missing from the reference → unable to verify.
- **Content comparison**: page mapping (explicit 1.0 > name 0.8 > heading 0.75; ambiguous →
  unable to verify); exact/contained match, capitalization (potential), changed wording ≥ 0.85
  (confirmed only on explicitly mapped pages), rewritten ≥ 0.6 (potential), missing; CTA/link
  text and target compared separately; word-diff evidence with document citations.
- **UI**: References tab (design reference with draft review, sources, Figma token, token editor
  with JSON import/export; content documents with status, page mapping, text viewer, retry,
  delete; auto-refresh while processing); wizard steps 2–3 with Figma link, guideline upload,
  manual values and content uploads, and a final step with live processing status and Start QA
  Scan; Scan readiness; per-scan comparison report (all verdicts, filter); scanner results and
  live scan links; evidence viewer for word diffs, color swatches and computed-style tables;
  findings filter includes design/content.
- **API**: design-spec (GET/PUT, draft confirm/discard), guideline upload, content documents
  (list/upload/patch/delete/blocks/retry), reference refresh/delete, Figma token (PUT/DELETE).
- **Fixtures**: documented design/content defects on the demo site, `design-spec.json`,
  `approved-content.md`, a Figma REST fixture, and real DOCX/PDF builders for tests.

## Tests completed (2026-10-04)
- Prettier, typecheck (root + all 10 workspaces), ESLint: pass. `npm run check:tsx-capture`: pass.
- `vitest`: **280 passed** (30 files; was 249), new:
  - extraction of real MD/TXT/DOCX/PDF files (headings, levels, lists, links, CTA targets,
    markers, PDF pages), failure cases (fake PDF, image-only PDF, code-only Markdown)
  - Figma normalization of the fixture file; REST client token header, node endpoint, 403/404/429/500
    and size cap; guideline extraction with citations
  - upload validation (types, MIME mismatch, UTF-8, zip bomb, ZIP-not-DOCX, file names)
  - design value comparison and verdict matrix; content mapping and verdict matrix; step planning
  - worker integration (real DB): document parsing in all formats, Figma via a local mock API
    (no token → unavailable, wrong token → failed, valid → draft → confirm, no-change refetch),
    guideline draft keeping manual values, stale recovery
  - API integration (real DB): uploads, rejections (fake PDF, .exe, bad path, oversize → 413),
    ownership isolation, draft conflicts/confirm/discard, encrypted write-only Figma token,
    reference freezing at scan start
  - **pipeline integration on the fixture with real Chromium: every design verdict (match,
    confirmed, potential, unable to verify) and all 13 content verdicts as documented**, styles
    per viewport and text only at the widest viewport; Phase 5 assertions unchanged and passing
- `next build`: pass.
- Playwright e2e: **7/7** (new: references page upload/editor → scan → comparison report →
  word-diff evidence; wizard with content upload and Start QA Scan; References page added to the
  accessibility audit at desktop and 390px: 0 violations, no overflow).
- Manual check in the browser (dev servers): wizard → project with manual values and a document →
  worker parsed it → scan → design 8 matched / 4 mismatched / 5 need review / 5 unable to verify,
  content 5 / 3 / 3 / 2; guideline upload produced a cited draft. This found two issues, both
  fixed: table pages overflowing at narrow widths (fieldset min-width; `sr-only` spans escaping
  scroll regions) and false palette near-misses from browser-default form-control colors.

## Known issues / limitations
- Figma: only local styles used by nodes, Button components named Primary/Secondary and a frame
  named "Container" are read; Variables (Enterprise API), spacing scales and visual (pixel) diffs
  against frames are not implemented. Not tested against the live Figma API (no token available);
  tested against a local mock that follows the documented REST response format.
- Guideline extraction reads literal values only; AI-assisted extraction is a Phase 7 candidate.
- Design mapping of buttons/containers without explicit selectors relies on class-name
  heuristics (reported as potential, never confirmed); free-form alignment is not compared.
- Content: a block counts as present if its text appears anywhere on the mapped page; scanned
  PDFs (no OCR) and tables in PDFs are not structured.
- The pre-existing scroll-region tables (projects, scans, issues, reports) have the same latent
  `sr-only` overflow pattern fixed in the new tables; they pass the current audits, so they were
  left unchanged.
- Observed in e2e logs: Next.js `MaxListenersExceededWarning` on the gzip stream (not investigated).
- Findings are not yet grouped into issues (Phase 7). Reports: Phase 8.
- Dev-tool `npm audit` findings, ESLint 9 pin, missing Docker unchanged.

## Next phase
Phase 7: AI provider abstraction, interpretation, grounding validator, deterministic fallback
(starts only after approval).

## Required environment variables
`DATABASE_URL`, `BETTER_AUTH_SECRET` (required); `ENCRYPTION_KEY` (required to store site
credentials and project Figma tokens; required in production); `TEST_DATABASE_URL` for integration
tests; optional `FIGMA_ACCESS_TOKEN`, `MAX_UPLOAD_MB`; `SCAN_ALLOWED_PRIVATE_HOSTS`, `SCAN_*`,
`LINK_CHECK_RETRIES`, `WORKER_CONCURRENCY`. See `.env.example`.
