# Manager demo — data manifest

Everything needed for an end-to-end QA Copilot demo, in one folder. **Brightline Studio is a
fictional company**; the website, brand guidelines and approved copy are demo data written for
this package. All findings come from real scans of the demo website (nothing is pre-written).

Guide: [END_TO_END_TEST_GUIDE.md](END_TO_END_TEST_GUIDE.md) · Presentation: [MANAGER_DEMO_SCRIPT.md](MANAGER_DEMO_SCRIPT.md)

## The six inputs

| # | Input | Exact value / path (repository-relative) | Format | Where it goes in QA Copilot | Verified |
|---|---|---|---|---|---|
| 1 | Website URL | `http://localhost:4100` (start with `npm run demo:manager`) | URL | New project → Step 1 → **Website URL** | Yes, by real scans on 2026-10-14 (see "Verification record") |
| 2 | Brand guidelines | `fixtures/manager-demo/brand/brightline-brand-guidelines.md` | Markdown | New project → Step 1 → **Brand guidelines (optional)** | Yes: extracted into 7 colours and H1–H6/body/link/button typography; confirmed values compared in a real scan |
| 3 | Font files | `fixtures/manager-demo/fonts/Geist-Variable-Latin.woff2` and `fixtures/manager-demo/fonts/Geist-Regular.ttf` (licence: `fonts/OFL.txt`) | WOFF2, TTF | New project → Step 1 → **Font files (optional)** | Yes: both accepted, read as family “Geist”; the website renders Geist (checked with Chromium's font engine during the scan) |
| 4 | Figma design URL | `https://www.figma.com/proto/Eav4PRP1fmlGFbjO0u0agY?node-id=9562-5216` (your “Ascendion_Dev” file) | Figma link | Step 2 → **Figma design URL (optional)** — see the caution below | Partly: read successfully by the live integration on 2026-10-11 (stored record); **not re-read on 2026-10-14** (to keep your scarce Figma quota); it is **not** a design of the demo website |
| 5 | Approved content | `fixtures/manager-demo/content/brightline-approved-content.md` | Markdown | Step 2 → **Content documents (optional)** → Add documents (leave “Website page” empty: the file contains page markers) | Yes: 30 blocks parsed; 28 matched, 2 genuine mismatches in a real scan |
| 6 | Page links | `http://localhost:4100/`, `/about`, `/services`, `/contact`, `/design-lab` | URLs | Step 2 → **Page links (optional)** → Page URL + **Add page** (once per URL) | Yes: all 5 stored, visited and loaded in real scans |

Optional extra: `fixtures/manager-demo/brand/brightline-design-values.json` — the same brand values
**plus** primary-button styling, container width (1200px) and the spacing scale (4–64px), which the
guideline reader does not extract. Import it on the References page **after** confirming the
guideline draft (manual values cannot be saved while a draft is waiting): Design reference →
Values → expand “Import or export JSON” → paste the file's text → **Load JSON into the editor** →
**Save as new version**. It
becomes a new confirmed version whose values are labelled “entered manually”.

### Figma caution (read before using input 4)
- The link points to your real Ascendion_Dev file, which the app read successfully on 2026-10-11
  (project “Ascendion - Trust article (full test)”). It proves the **live Figma integration**, but
  that file is **not the Brightline demo design**. Figma values are merged into the **same pending
  draft** as the brand-guideline values (and can replace guideline values for the same items), so
  confirming that draft would mix unrelated Ascendion values into the Brightline reference.
- Recommended demo: leave the Figma field empty in the demo project and show the live Figma result
  on the existing project instead (References page → Figma source, manifest of pages read).
- Token check on 2026-10-14: the configured token is recognised by Figma and has the scopes
  `file_content:read` and `file_metadata:read` (enough for file reads). Whether it can still read
  this file today was **not** re-tested.
- To get a Figma file that really matches the demo site, follow
  [figma/FIGMA_DESIGN_SPEC.md](figma/FIGMA_DESIGN_SPEC.md) (you create it in Figma; it cannot be
  created through the API).

## Demo website pages

All routes exist in `fixtures/manager-demo/site/server.mjs`. Navigation links Home, About,
Services and Contact; **Design lab is not linked from anywhere**, so it is only scanned because it
is a page link.

| URL | Purpose | Rules that apply | Intentional defects (original variant) | Scanners that report them |
|---|---|---|---|---|
| `http://localhost:4100/` | Home | H1/H2/H3, body, colours, buttons, approved copy | CTA reads “Book a consultation” (approved: “Book a free consultation”); link to `/case-studies` (404); award image `/images/award-badge.png` (404) | Content (`content-changed-wording`), Broken links (`broken-internal-link`, `failed-resource`) |
| `http://localhost:4100/about` | About | H1 48/56, images, approved copy | H1 drawn 40px/48px; approved paragraph “Since 2015 …” missing; team photo without alt text; team photo 900×600 squeezed into 600×250 | Design comparison (H1 size/line height), Design Quality (H1 inconsistency, stretched image), Content (`content-missing`), Accessibility (`image-alt`), SEO (`img-alt-attribute-missing`) |
| `http://localhost:4100/services` | Services | H2 32/40 600, spacing, images | No meta description; one H2 styled 26px/400; service cards spaced 48px then 24px; 48×48 icon shown at 192×192 | SEO (`meta-description-missing`), Design comparison (H2 size/weight/line height), Design Quality (H2 inconsistency, uneven spacing, enlarged image) |
| `http://localhost:4100/contact` | Contact | Forms, buttons | Email field without a label; the submit `<button>` does not inherit the page font (renders Arial 13.33px — a real CSS omission, found by the scan) | Accessibility (`label`), Design comparison (button text family/size, “needs review”) |
| `http://localhost:4100/design-lab` | Design lab (page link only) | Fonts, hierarchy, alignment, responsive | Web font “Geist Display” whose file 404s (Geist renders instead); H3 36px larger than H2 32px; two stacked blocks 3px apart; 1100px banner | Design Quality (web font not rendered, font not in brand fonts, hierarchy, H3 inconsistency, near-miss alignment), Design comparison (H3, body family/size), Links (`failed-resource` font), Responsive (`horizontal-overflow` at tablet and mobile) |

Site-wide (served over plain HTTP without security headers, as a local demo):
Security (`https-not-used`, `csp-missing`, `frame-protection-missing`,
`x-content-type-options-missing`, `referrer-policy-missing`, `permissions-policy-missing`),
SEO (`open-graph-missing`, `structured-data-absent`), Performance (`render-blocking-resource`).

Not defects (pass examples): the Home hero image (1600×640 shown ≤ 1152px wide), Geist loading
and rendering on every main page, Contact copy, Services copy, 28 of 30 approved-content blocks.

### Fixed variant (for the re-scan)
`POST http://localhost:4100/__demo/variant` with body `fixed` (or start with
`node fixtures/manager-demo/site/server.mjs 4100 fixed`) repairs: About H1 size, the missing About
paragraph, the Home CTA wording, the Services meta description, the Services card spacing, the
About image alt text and the Contact email label. Everything else stays (persistent issues).
Switch back with body `original` or restart `npm run demo:manager`.

## Verification record (2026-10-14, isolated test environment)

Real application (production build, worker, test database `qa_copilot_test`, AI off, Figma off),
real Chromium, the demo website served from this folder on a private port:

- Project created with 5 page links; brand guideline, both fonts and the approved content uploaded
  through the same API the UI uses; guideline draft (version 1) confirmed; document parsed (30
  blocks).
- Scan #1 (original): every step **Completed** (AI skipped: no provider configured in the test
  environment). Crawl: “page links: 5 of 5 added by you loaded”. Design comparison: 17 matched, 10
  mismatched, 2 need review, 16 unable to verify. Content: 28 matched, 2 mismatched. Design
  Quality: 10 findings, all six parts checked. 42 findings grouped into 38 issues.
- Scan #2 after switching to the fixed variant: comparison **9 resolved, 28 persistent, 1
  changed, 0 new**. Markdown report generated.
- Counts can differ on your machine (for example with AI enabled the issue wording differs, and
  lab performance measurements vary). Treat them as an example, not a promise.

## Configuration requirements and external dependencies

| Item | Needed for | Status |
|---|---|---|
| Node.js ≥ 22.12, PostgreSQL 18, `.env` with `DATABASE_URL` | Everything | Present on this machine |
| `SCAN_ALLOWED_PRIVATE_HOSTS=localhost:4100` (in `.env`) | Scanning a site on localhost | Present; that is why the demo site uses port 4100 |
| Playwright Chromium | Browser capture | Installed (scans ran) |
| `FIGMA_ACCESS_TOKEN` | Live Figma reads | Set; scopes `file_content:read`, `file_metadata:read` |
| `AI_PROVIDER=gemini` + key | AI-written issue text | Set in `.env` (free tier ≈ 20 requests/day). Without it, issues use the scanners' wording plus built-in explanations |
| Internet | Figma and Gemini only | The demo website, scans and reports work offline |
