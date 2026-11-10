# Approachable Design — QA Copilot test package

Test inputs for scanning **https://www.approachabledesign.co/newsletter/** with QA Copilot.
Everything here was measured from the live site on 2026-10-17 or downloaded from an official
open-source font repository. Approachable Design is a third-party website: **only scan it if you
are authorized to test it** (QA Copilot asks you to confirm this before every scan). Scans make
normal page requests only.

## The six inputs

| # | Input | Value / file (repository-relative) | Where it goes |
|---|---|---|---|
| 1 | Website URL | `https://www.approachabledesign.co/newsletter/` | New project → Step 1 → **Website URL** |
| 2 | Brand guidelines | `fixtures/approachable-design/brand/approachable-design-brand-guidelines.md` | Step 1 → **Brand guidelines** |
| 3 | Font files | `fixtures/approachable-design/fonts/Inter-Variable.ttf`, `fixtures/approachable-design/fonts/Manrope-Variable.ttf` | Step 1 → **Font files** (select both) |
| 4 | Figma design URL | `https://www.figma.com/design/uJ27pZGYseRcxbeab1VWRA/Approachable-Design---Newsletter-page--QA-test-?node-id=1-12` (details: `figma/FIGMA_LINK.md`) | Step 2 → **Figma design URL** |
| 5 | Content document | `fixtures/approachable-design/content/approachable-design-approved-content.md` (filled; ready to upload) | Step 2 → **Content documents → Add documents** |
| 6 | Page links | the list below | Step 2 → **Page links** → **+ Add page** for each |

### 6. Page links (all checked: HTTP 200 on 2026-10-17)

```
https://www.approachabledesign.co/newsletter/
https://www.approachabledesign.co/
https://www.approachabledesign.co/about/
https://www.approachabledesign.co/articles/
https://www.approachabledesign.co/products/
https://www.approachabledesign.co/products/creator-design-kit/
https://www.approachabledesign.co/products/youtube-masterclass/
https://www.approachabledesign.co/products/design-vault/
```

These are the site's own internal links found on the Newsletter page. The site redirects the
versions without a trailing slash to these URLs.

## What each file contains

**Brand guidelines** — values measured from the page's computed styles, written so QA Copilot's
guideline reader extracts them (checked with the real extractor: 4 colours, H1, H2, H4, body and
button typography, nothing skipped):
- Colours: Primary text #0B0A16, Page background #FFECE2, Header background #FFECE2, Brand purple #5148CA.
- H1 72px/72px, weight 900, italic; H2 24px/32px, weight 900, italic — font “Domaine Display Black Italic”.
- H4 Manrope Semibold 14px/20px, letter spacing 0.7px; Body Inter Regular 18px/28.8px; Button Manrope Semibold 16px/24px.
- It is a test reference, not Approachable Design's official guideline.

**Font files** — Inter and Manrope, the two free fonts the site loads from Google Fonts, downloaded
from github.com/google/fonts (official Google Fonts repository), unmodified, with their licences
(`Inter-OFL.txt`, `Manrope-OFL.txt`, SIL Open Font License 1.1). Both pass QA Copilot's font
validator (families “Inter” and “Manrope”, variable fonts).
The heading font **Domaine Display Black Italic is a commercial font (Klim Type Foundry) and is not
included**. Expect QA Copilot's Design Quality scanner to report the headings as “not one of the
uploaded brand fonts”: that is a true statement about the uploaded files, not a website defect.

**Content document** — the Newsletter page's main copy as supplied by you on 2026-10-17 (headline,
intro, sign-up button, note, testimonials heading, nine testimonials with names, the brand blurb),
with the `/newsletter/` page marker; navigation, footer link lists and the copyright line are left
out. Checked with QA Copilot's extractor: 37 entries, all mapped to `/newsletter/`. Because it is the
page's current text, the content check should show matches; edit a line before uploading to see a
mismatch reported. `content/fill-content-from-page.js` can regenerate it from the live page.

## Expected behaviour (to check, not promised)
- Design comparison: H1/H2/body/button values should mostly match (they were measured from this
  page). Paragraph styles that differ from the body rule (the 20px intro paragraphs, 14px small
  print) can be reported, and so can pages other than Newsletter that use different styles.
- The primary button's corner radius is set on the site to an extreme value (about 22,369,600px,
  which browsers draw as a pill). If you confirm a Figma or JSON value for the radius, the
  comparison will report the numeric difference.
- Security, SEO, links, performance, accessibility and responsive results are whatever the live
  site really has today; they can change when the site changes.
- AI: with `AI_PROVIDER=gemini` in `.env`, issue text is written by AI and checked against the
  evidence (free-tier quota ≈ 20 requests/day); otherwise built-in explanations are used.
