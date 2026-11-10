# QA Copilot — end-to-end test guide (Windows + VS Code)

Goal: run QA Copilot locally, create the demo project with all six inputs, scan the demo website
for real, inspect the findings and their evidence, fix a defect, re-scan and compare.
All demo data is in this folder; see [DATA_MANIFEST.md](DATA_MANIFEST.md) for the full list.

Time needed: about 15 minutes for setup, 3–5 minutes per scan.

---

## Step 1 — Prepare the environment

1. **Open the repository in VS Code:** File → Open Folder → `C:\Users\Siddharth\Downloads\qa-copilot`.
   Open a terminal with **Terminal → New Terminal** (PowerShell). You will need **three**
   terminals (the **+** button in the terminal panel adds one).
2. **Node.js** (needs 22.12 or newer):
   ```powershell
   node -v
   ```
3. **Database connection** (PostgreSQL must be running; this only connects and reports):
   ```powershell
   npm run db:check
   ```
   Expected: `OK: PostgreSQL 18.x, database "qa_copilot" (… ms)` (the URL it prints has the
   password masked). If it fails, start the
   Windows service `postgresql-x64-18` (Services app → Start).
4. **Database schema up to date** (applies only migrations that are missing; it never deletes data):
   ```powershell
   npm run db:migrate
   ```
   Expected last line: `migrations up to date`.
5. **Environment variables without showing secrets** (prints only the names):
   ```powershell
   Get-Content .env | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { ($_ -split '=')[0] }
   ```
   You should see at least `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`,
   `SCAN_ALLOWED_PRIVATE_HOSTS`. To see the one non-secret value that matters for the demo:
   ```powershell
   Select-String -Path .env -Pattern '^SCAN_ALLOWED_PRIVATE_HOSTS='
   ```
   It must include `localhost:4100` (it does on this machine). That is the only local address the
   scanners may visit, which is why the demo website runs on port 4100.
6. **Playwright browser:** scans use Playwright's Chromium, already installed here. Only if a scan
   fails with “Executable doesn't exist”, run `npx playwright install chromium` once.
7. **Do not run** `npm run db:bootstrap` or any reset command; none is needed.

## Step 2 — Start the application (three terminals, in this order)

Before starting, stop anything still running from an earlier session on ports 3000, 3001 or 4100
(press **Ctrl+C** in the terminal where it runs). The old fixture site (`npm run demo:site`) also
uses port 4100 and must be stopped.

| Terminal | Command | Ready when you see |
|---|---|---|
| 1 — demo website | `npm run demo:manager` | `Brightline Studio demo website (original) running at http://localhost:4100/` |
| 2 — web app | `npm run dev:web` | `✓ Ready in …` and `Local: http://localhost:3000` |
| 3 — worker | `npm run dev:worker` | A JSON log line with `"msg":"worker starting"`, then no errors; http://127.0.0.1:3001/health answers (scans, documents, Figma and reports are processed here) |

(`npm run dev` starts web and worker together in one terminal if you prefer.)

Check that everything answers:
- Demo website: `npm run demo:manager:check -- http://localhost:4100` → 15 lines `OK` and
  `All checks passed.`
- Web app: open http://localhost:3000/api/v1/health → `{"status":"ok",…}`;
  http://localhost:3000/api/v1/health/ready also checks the database.
- Worker: open http://127.0.0.1:3001/health → `"status":"ok"` and `"scanWorker":{"status":"running"…`.

**Port already in use** (`EADDRINUSE`): find the program and stop it.
```powershell
Get-NetTCPConnection -LocalPort 4100 -State Listen | Select-Object OwningProcess
Get-Process -Id <the number shown>
```
If it is an old QA Copilot terminal, press Ctrl+C there (or `Stop-Process -Id <number>`), then start
the command again.

Open the app: **http://localhost:3000** and sign in (or **Create one** on the login page).

## Step 3 — Create the demo project

**Projects → New project.** The wizard has five steps (Project → Figma / brand → Configure scan →
Review → Start scan). Only the project name and website URL are required.

**Step 1 of 5: Project**
1. **Project name:** `Manager Demo — Website QA Copilot`
2. **Website URL:** `http://localhost:4100`
3. **Brand guidelines (optional):** Choose Files →
   `fixtures\manager-demo\brand\brightline-brand-guidelines.md`
4. **Font files (optional):** Choose Files → select **both**
   `fixtures\manager-demo\fonts\Geist-Variable-Latin.woff2` and `Geist-Regular.ttf`.
   Each file is listed with its size and a remove button. (A wrong file type, e.g. a `.txt`, is
   refused immediately with a message.)
5. **Continue.** The URL is checked; files are uploaded only after the project is created.

**Step 2 of 5: Figma / brand**
6. **Figma design URL (optional):** leave **empty** for the stable demo (see the Figma note in
   DATA_MANIFEST.md). For a live Figma test, use a separate project or follow
   `figma/FIGMA_DESIGN_SPEC.md`.
7. **Content documents (optional) → Add documents:**
   `fixtures\manager-demo\content\brightline-approved-content.md`. Leave “Page, e.g. /about”
   empty: the document contains `<!-- page: /about -->` markers.
8. **Page links (optional):** type each URL in **Page URL** and click **+ Add page** after each:
   - `http://localhost:4100/`
   - `http://localhost:4100/about`
   - `http://localhost:4100/services`
   - `http://localhost:4100/contact`
   - `http://localhost:4100/design-lab`

   “Added pages (5)” lists them. Try a wrong one to see validation: `https://example.org/x` →
   “This page is on a different website…”, or `/about/` again → “/about is already in the list.”
   Page links are website pages, not Figma frames; the app does not map pages to Figma frames.
9. **Continue.**

**Step 3 of 5: Configure scan** — see Step 4 of this guide, then **Continue**.

**Step 4 of 5: Review** — check every row (Brand guidelines, Font files, Content, Page links,
Scanners …), then **Create project**.

**Step 5 of 5: Start scan** — the Files list shows each upload with real progress and **Uploaded**
(the font rows say “Font file read: “Geist” Regular”). A failed upload shows the reason and
**Retry**. **Do not start the scan yet:** the brand-guideline values are a draft that must be
confirmed first.

10. Click **Open References** (or Open project → **References** tab) and wait until:
    - Design reference shows “Draft version 1 from a brand guideline is waiting for review: N
      changes” with each value and its source line (e.g. `brightline-brand-guidelines.md, line …:
      “H1 - Geist Bold, 48px / 56px, #111827”`). Click **Confirm draft**.
    - Brand fonts lists “Geist” (Regular · weight 400 · …) twice (one per file).
    - Approved content shows the document as **Completed** with its blocks.
    - Page links shows “Added pages (5)”.
11. Refresh the page (F5): all of the above is still there (persistence check).
12. Optional: add buttons, container width and the spacing scale by importing
    `brand\brightline-design-values.json` (Design reference → Values → Import or export JSON →
    paste → Load JSON into the editor → Save as new version).

## Step 4 — Configure the scan

In wizard step 3 (or later in the project's **Settings → Default scan configuration**) keep all
seven scanners ticked:

| Scanner | What it checks | Demo defect it should find |
|---|---|---|
| Accessibility | axe-core WCAG rules | About image without alt text; Contact email field without a label |
| Security | Passive HTTPS/header/cookie checks | Plain HTTP and missing security headers (a local demo site) |
| SEO | Titles, descriptions, headings, robots, sitemap… | Services has no meta description; About image without alt |
| Broken links / mixed content | Links and resources | `/case-studies` (404), award image (404), Geist Display font file (404) |
| Performance | Lab speed and weight | Render-blocking stylesheet (other results depend on your machine) |
| Responsive / visual | Layout at desktop/tablet/mobile | 1100px banner on Design lab overflows tablet and phone |
| **Design Quality & Typography** | Heading typography, fonts, image clarity, spacing, alignment, plus the reference/content results | See Step 6 |

Viewports desktop/tablet/mobile, Maximum pages 25, depth 3, Respect robots.txt on.

Design comparison and Content comparison are not checkboxes: they run automatically when the
project has a **confirmed** design reference / a **processed** content document; otherwise their
steps are **Skipped** with the reason. A missing Figma link, AI provider or content document never
invalidates the other scanners.

## Step 5 — Run the scan

1. Project → **Scan** tab. “Scan readiness” lists Website, Design reference (should say version 1
   is confirmed), Approved content, Scanners (7 of 7).
2. Tick **I am authorized to test http://localhost:4100/** → **Start QA Scan**. The scan page
   shows live progress.
3. Step statuses mean:
   - **Pending** — waiting; **Running** — in progress;
   - **Completed** — ran; findings (if any) are real;
   - **Failed** — the step could not run (the reason is shown); other steps continue;
   - **Inconclusive** — it ran but could not verify everything (e.g. Design Quality when the
     design comparison failed); the reason lists what was and was not checked;
   - **Skipped** — not applicable (e.g. AI with no provider, comparisons without references).
4. Where to look afterwards (all from the scan page or the project tabs):
   - **Issues** tab / scan → Issues: grouped issues with plain-language explanations.
   - Scan → **Findings**: every raw finding (e.g. `DQ-005`, `DSN-001`) with evidence.
   - Scan → **Comparison** (or Scanner results → View comparison): every compared design value,
     content block and the Design Quality parts, with Match / Confirmed mismatch / Needs review /
     Unable to verify.
   - **Pages** tab: every page with counts per category; page links carry “Your page link”.
   - **Scanner results** tab: status, findings, tool and the reason per step.
5. Real vs unverified: a finding's verdict is **Confirmed** (measured directly), **Needs review**
   (signs of a problem, a person must judge) or **Unable to verify**. Comparison items marked
   “Unable to verify” are not defects; they mean no reference value or no matching element.

## Step 6 — Validate the Design Quality & Typography scanner

Preconditions for all cases: Steps 3–5 done with the original variant of the demo site.

| # | Test case | Steps | Expected (real behaviour) | Evidence | Pass if | If it fails |
|---|---|---|---|---|---|---|
| 1 | H1 font size vs reference | Scan → Comparison → Design comparison | “Heading 1 font size”: Confirmed mismatch, expected 48px, found 40px on `/about`, source = guideline line | Findings `DSN-…` “Heading 1 font size: 40px instead of 48px” with computed-style evidence and screenshot | Expected value comes from the guideline, actual from the page | Check the draft was confirmed before the scan (Scan readiness) |
| 2 | H2 font size/weight | Same, Design comparison | “Heading 2 font size: 26px instead of 32px” and weight 400 vs 600 on `/services` | Computed styles of the “QA audits” heading | Both found | Same as above |
| 3 | H1–H6 consistency | Scan → Findings → filter Design Quality | `dq-heading-inconsistent` for H1 (40 vs 48), H2 (26/400 vs 32/600) and H3 (36 vs 24): **Needs review** | Evidence lists every style variant per screen size with pages and selectors | Each variant is a real measured style | — |
| 4 | Heading hierarchy | Same | `dq-heading-hierarchy-inverted` “H3 headings are larger than H2 headings” on `/design-lab` | Median sizes per level | Present | Is `/design-lab` in the page links? |
| 5 | Font family / rendering | Same | `dq-webfont-not-rendered` **Confirmed**: “Geist Display” declared, rendered with Geist (web font); `dq-font-not-approved` for “Geist Display” | “Web font status reported by the page: … error”; platform fonts from Chromium | Main pages show no font finding (Geist renders) | Were both font files uploaded before the scan? |
| 6 | Weight and style | Design comparison | H2 weight mismatch (case 2); italic never appears | — | — | — |
| 7 | Spacing | Design Quality | `dq-spacing-inconsistent` “Uneven vertical spacing between repeated div.service-card items” (48px, 24px) | Gap measurements and screenshot | Present | — |
| 8 | Alignment | Design Quality | `dq-alignment-near-miss` “… 3px apart” on `/design-lab` | Left edges of both blocks | Present | — |
| 9 | Image clarity | Design Quality | `dq-image-upscaled` “Image shown 4× larger than its source resolution” (Services icon) and `dq-image-distorted` “aspect ratio changed by 60%” (About photo). The Home hero is **not** reported (it is large enough) | Intrinsic vs displayed size, object-fit | Both found, hero not | — |
| 10 | Approved content | Comparison → Content comparison, and Design Quality part “Approved-content verification” | “Call to action text differs: “Book a consultation”” (Home) and “Content missing: Since 2015 …” (About); the other blocks Match; the Design Quality part says it was checked by the Content comparison | Word diff and document location | Two mismatches, the rest matched | Document must be Completed before the scan |
| 11 | Missing references → inconclusive | Comparison → Design Quality section | H4–H6 / some heading items “Unable to verify” where no element or value exists; spacing part says “No spacing scale in the design reference” unless you imported the JSON; checks against Figma frames listed as not available | Item details | Nothing is invented | — |
| 12 | Missing approved content | Create a second project without the content document and scan | Design Quality part “Approved-content verification: Not configured — Skipped: no processed approved content document…”; Content comparison step **Skipped** | Scanner results | Other parts still checked | — |

Not implemented (gaps, do not expect them): blur/compression analysis of images, pixel comparison
with Figma frames, automatic page↔Figma-frame mapping, checking the heading **spacing** rules from
the guideline text (only the JSON spacing scale is checked).

## Step 7 — Validate the existing scanners

For each finding, open it (Findings or the issue page → **Technical details and evidence**). Real
evidence is always attached: axe node HTML and WCAG reference (accessibility), response headers
(security), page HTML/metadata (SEO), the HTTP status of the link check and where it is linked from
(links), lab measurements (performance), box measurements and screenshots (responsive).

| Scanner | Look for | Source of the finding |
|---|---|---|
| Accessibility | `image-alt` on `/about`, `label` on `/contact` | axe-core in Chromium |
| Security | `https-not-used`, `csp-missing`, `frame-protection-missing`, … | Response headers of the demo site |
| SEO | `meta-description-missing` (`/services`), `img-alt-attribute-missing`, `open-graph-missing`, `structured-data-absent` | Served HTML |
| Broken links | `broken-internal-link` (`/case-studies`), `failed-resource` (award image, Geist Display font) | HTTP checks |
| Performance | e.g. `render-blocking-resource`; values vary by machine | Chromium performance APIs |
| Responsive | `horizontal-overflow` on `/design-lab` at tablet and mobile | Layout measurement + screenshot |

A category with no finding is fine when its condition is absent (e.g. no mixed content on a plain
HTTP site).

## Step 8 — Check the issue explanations

Open **Issues** and click, for example: “Web font “Geist Display” is declared but a fallback font is
shown”, “Heading 1 font size: 40px instead of 48px”, “Form elements must have labels”. Each issue
page shows:
- **In plain language**: What is the problem? / Why does it matter? / What should I do next?
- **Where it was found**: pages, screen sizes, element selector, recorded HTML, measured values.
- **How to fix it** (steps) and **Example fix** (code with [placeholders]; labelled as a suggestion).
- **How to verify the fix** (ending with a re-scan; marking Resolved does not verify anything).
- **Technical details and evidence** (collapsed): raw findings, evidence, screenshots, validation.

Pass: expected values shown are the ones from your guideline (e.g. 48px) or measured on the page;
nothing says the issue is fixed before a new scan confirms it. With AI enabled, AI-written parts
are labelled and checked against the evidence.

## Step 9 — Fix, re-scan, compare

The demo website has a built-in “fixed” version, so you do not need to edit code:
1. In a fourth terminal:
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://localhost:4100/__demo/variant -Body fixed
   ```
   (Answer: `fixed`.) Or stop terminal 1 and run `node fixtures/manager-demo/site/server.mjs 4100 fixed`.
2. Project → Scan → start a new scan.
3. Project → **Scan history** → compare the two scans (or the new scan's comparison link).
   Expected: issues fixed by the variant are listed as **Resolved** (H1 size and line height,
   CTA wording, missing About paragraph, Services meta description, card spacing, About alt text,
   email label); the rest are **Persistent**. Counts depend on the actual scans.
4. Restore the original: `Invoke-RestMethod -Method Post -Uri http://localhost:4100/__demo/variant -Body original`
   (or restart `npm run demo:manager`). To change the site by hand instead, edit
   `fixtures/manager-demo/site/server.mjs` and restart terminal 1; undo with
   `git checkout -- fixtures/manager-demo/site/server.mjs` only if that file has no other changes
   you want to keep.

## Step 10 — Persistence and reports

- Refresh the References page: fonts, page links, document and confirmed reference remain.
- Project → **Settings**: scanner selection and limits are kept.
- **Issues** → open an issue → change Status (e.g. In progress, with a note) → it is recorded in
  the issue's history. Resolved issues that reappear in a later scan become **Reopened**.
- **Reports** tab (or the scan page) → generate **PDF**, **Markdown** or **JSON** for a finished
  scan → download. Reports list every step (including Design Quality and its parts), issues with
  plain-language explanations and source findings.
- **Scan history**: both scans with counts and the change against the previous scan.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| “Request validation failed” when creating a project | The web server runs older code; stop it (Ctrl+C) and run `npm run dev:web` again. The error now lists the rejected field. |
| Website URL rejected as private/internal | `.env` `SCAN_ALLOWED_PRIVATE_HOSTS` must contain `localhost:4100`; restart web and worker after changing `.env`. |
| Design comparison **Skipped** | The guideline draft was not confirmed before the scan. Confirm it, scan again. |
| Content comparison **Skipped** | The document was still processing. Wait for **Completed**, scan again. |
| Scan stays **Queued** | The worker (terminal 3) is not running. |
| Upload fails “already uploaded” | The same file is already attached to the project (duplicates are refused). |
| `npm error Missing script` | Typo in the command (e.g. `dev:webcd`); use the exact commands above. |
| E2E tests (`npx playwright test`) behave strangely | They expect the old fixture on port 4100; stop `npm run demo:manager` and let them start their own. Run them only against the test database. |
