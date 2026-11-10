# Ascendion — QA Copilot test package

Test inputs for scanning **https://ascendion.com/** with QA Copilot, centred on the article
**https://ascendion.com/ai-basic/why-enterprise-agentic-ai-stalls-before-production/**.
Prepared on 2026-10-22 from the files and links you supplied, the live website and Ascendion's
Figma file. Only scan the site if you are authorized to test it (QA Copilot asks you to confirm this
before every scan). Scans make normal page requests only.

## The six inputs

| # | Input | Value / file (repository-relative) | Where it goes |
|---|---|---|---|
| 1 | Website URL | `https://ascendion.com/` | New project → Step 1 → **Website URL** |
| 2 | Brand guidelines | `fixtures/ascendion/brand/ascendion-brand-guidelines.md` | Step 1 → **Brand guidelines** |
| 3 | Font files | `fixtures/ascendion/fonts/IBMPlexSans-Variable.ttf`, `fixtures/ascendion/fonts/IBMPlexSans-Italic-Variable.ttf` | Step 1 → **Font files** (select both) |
| 4 | Figma design URL | `https://www.figma.com/design/Eav4PRP1fmlGFbjO0u0agY/Ascendion_Dev?node-id=3176-16686` (details: `figma/FIGMA_LINK.md`) | Step 2 → **Figma design URL** |
| 5 | Content document | `fixtures/ascendion/content/why-enterprise-agentic-ai-stalls-before-production.md` | Step 2 → **Content documents → Add documents** |
| 6 | Page links | the 7 links in `page-links/RECOMMENDED_PAGE_LINKS.md` | Step 2 → **Page links** → **+ Add page** for each |

Step 3: keep **Maximum pages 10** and **Maximum link depth 1**, and leave all scanners on.

## Test steps (in this order)

1. In VS Code, start the web app and the worker as usual (`npm run dev:web`, `npm run dev:worker`).
2. **New project**. Enter the six inputs above, then **Create project**.
3. On the last wizard step, **do not click Start QA Scan yet**. Click **Open References** and wait
   until the Figma source, the brand guideline and the content document all show **Ready**.
4. Review the draft design reference (brand guideline and Figma values merged), then click
   **Confirm draft**. *This is what was missing in the last round: without a confirmed reference
   the design comparison is skipped.*
5. Open **Scan**. "Scan readiness" should show a confirmed design reference, 1 content document and
   7 page links. Tick the authorization box, then **Start QA Scan**.
6. When it finishes, review the **Issues**, **Comparisons** (design and content) and **Pages** tabs,
   then download the report.

## What each file contains

**Brand guidelines.** Transcribed from Ascendion's own design-system frames in Figma: UI_Kit (node 313:3425,
the link you gave) and Updated_UI_Kit (node 7889:24666). The newer frame wins where both give a
value, and the website's CSS uses those newer values too. Contents: the 4 brand colours and
6 neutral greys; PP Neue Machina and IBM Plex Sans; H1–H6, body (Body/Body-S) and button (Body/CTA)
styles; the full desktop/tablet/mobile type scale; breakpoints, grid, spacing and buttons.
Checked with QA Copilot's real guideline reader: it extracts **10 colours and 8 text styles, with
nothing skipped**.

**Font files.** IBM Plex Sans (the site's body font), downloaded unmodified from
github.com/google/fonts (the official Google Fonts repository), with its licence `IBMPlexSans-OFL.txt`
(SIL Open Font License 1.1). Both files pass QA Copilot's font validator (family "IBM Plex Sans";
Regular and Italic, variable). The heading font, **PP Neue Machina**, is a commercial font (Pangram
Pangram Foundry) and is not included. Expect the Design Quality scanner to report headings as "not
one of the uploaded brand fonts". That is a true statement about the uploaded files, not a website
defect.

**Content document.** Your PDF, `Final SEO Title_ Why Enterprise Agentic AI Stalls Before Production.pdf`,
is kept unchanged as `content/why-enterprise-agentic-ai-stalls-before-production (original).pdf`.
**Upload the `.md` version.** It has the same words: a word-by-word check against QA Copilot's PDF
reader found no differences except that the superscript "AI" marks are written inline, as the
website shows them. Only the layout is repaired:
- the PDF breaks the title and one heading over two lines;
- a paragraph is split by a page break;
- the three gap sub-headings are plain text in the PDF.

Uploaded as-is, those breaks would show up as false "missing" or "changed" results. The `.md` also
carries the page marker for the article. If you upload the PDF instead, type
`/ai-basic/why-enterprise-agentic-ai-stalls-before-production/` in its **Website page** box.

**Page links.**
- `page-links/RECOMMENDED_PAGE_LINKS.md`: the 7 links for this test, with the reason for each.
- `page-links/ALL_PAGE_LINKS.md` and `page-links/all-page-links.txt`: all 337 working pages from the
  site's sitemaps, grouped by section.

**Figma.** `figma/FIGMA_LINK.md` covers the chosen frame (T16-Insight Inner, the article template),
why it was chosen over the other 52 Figma pages, and the Figma read budget.

## Differences found while preparing (checked by hand on 2026-10-22)

These are real differences between your content document and the live page, checked directly in the
page and its HTML. The scan should find the first two by itself. The SEO title and meta
description are not compared with the content document by QA Copilot, so they are recorded here
for your report.

| # | What | Content document (PDF) | Live page today |
|---|---|---|---|
| 1 | Missing section | Heading **"What Is Agentic AI for Enterprise?"** and its paragraph ("Agentic AI for enterprise means AI agents that plan and carry out multi-step work…") | Not on the page: the article goes from the introduction straight to "What a Pilot Proves…" |
| 2 | Wrong link text in the closing paragraph | "Learn more at https://www.ascendion.com." | "Learn more at **https://dev1.intarcs.com**." The link text shows a development/staging address; the link itself goes to https://ascendion.com/ |
| 3 | SEO title | "Why Enterprise Agentic AI Stalls Before Production" | `<title>`: "Why Agentic AI for Enterprise Stalls in Pilots \| Ascendion" |
| 4 | Meta description | "Most agentic AI pilots impress the room and never reach production. See the three gaps that stop deployment and what closes them." | "Gartner expects over 40 percent of agentic AI projects to be canceled by 2027. The three gaps between a working pilot and production, and what closes them." |
| 5 | Sitemap | — | 8 sitemap URLs return 404 and 18 redirect; an error-page template (/4-0-4/) is listed. Details in `page-links/ALL_PAGE_LINKS.md` |

Design values measured on the live article at 1440px wide, for comparison with the guidelines (the
scan measures these itself; listed so you can check its results):

| Element | Brand guideline | Live page |
|---|---|---|
| Article title (H1) | PP Neue Machina 60px / 76px, letter spacing 0 | PP Neue Machina 47.95px / 56px, letter spacing −0.48px |
| Section headings (H2) | 48px / 56px | 32px / 40px |
| Gap sub-headings (H3) | PP Neue Machina 32px / 40px | IBM Plex Sans Bold 21.06px / 26px |
| Body paragraphs | IBM Plex Sans Light (300) 18px / 26px | IBM Plex Sans Regular (400) 18px / 26px |
| Links in text | Dark Teal #008567 is a brand colour | #008567 (matches) |

The article template may define smaller headings than the site-wide scale. The Figma T16 frame
says which: once it is read and confirmed, its values replace the guideline values in the draft
wherever both define them.

## Things to know
- Figma: one file read per **Extract again**. The account has a viewer seat (about 20 reads a month),
  so avoid repeated re-reads. Preparing this folder used 2.
- AI: with `AI_PROVIDER=gemini` in `.env`, issue text is written by AI and checked against the
  evidence. The free tier allows about 20 requests a day; otherwise built-in explanations are used.
- Security, SEO, links, performance, accessibility and responsive results reflect the live site at
  scan time and can change when the site changes.
