# QA Copilot — manager demo script (8–10 minutes)

**Prepare 15 minutes before** (so nothing is waited on live):
1. Start the three terminals (END_TO_END_TEST_GUIDE.md, Step 2) and run
   `npm run demo:manager:check -- http://localhost:4100` → “All checks passed.”
2. Create the project **Manager Demo — Website QA Copilot** with all inputs, confirm the guideline
   draft and run **one complete scan** in advance (Guide Steps 3–5). Keep that scan as the
   “before” result.
3. Open browser tabs: (a) http://localhost:4100 (the demo site), (b) the project's **References**
   tab, (c) the finished scan page, (d) the issue “Web font “Geist Display” is declared but a fallback
   font is shown”, (e) the New project wizard (to show the inputs without creating a duplicate).
4. Optional live Figma proof: the existing project “Ascendion - Trust article (full test)” →
   References (Figma file Ascendion_Dev, read by the live integration on 2026-10-11).

Brightline Studio is a fictional company and its website runs locally with planted, documented
defects. Say so: it makes the results reproducible and checkable.

---

## 0:00 — The problem (45 s)
> “Before a website goes live, someone checks it against the brand guidelines, the approved copy
> and basic quality rules: accessibility, SEO, broken links, performance, mobile layout. That is slow
> and inconsistent when done by hand. QA Copilot does it automatically and shows evidence for every
> finding, and it never makes up a result.”

## 0:45 — Project setup (2 min) — tab (e)
Walk through the wizard without creating a second project:
- Step 1: name, **Website URL**, **Brand guidelines** (our brand PDF/Markdown), **Font files**
  (the brand's Geist font files). > “Only name and URL are required; everything else is optional.”
- Step 2 **Figma / brand**: Figma design URL (optional), **Content documents** (the approved copy
  signed off by marketing), **Page links** with **+ Add page**: > “These are pages we want checked
  even if nothing links to them — like this Design lab page.” Show the validation by adding
  `https://example.org/x` (“different website”).
- Step 3: the scanners, including the new **Design Quality & Typography**.
- Then switch to tab (b), References: > “The brand values were read from the guideline document,
  each with the line it came from. Nothing is used until a person confirms it.” Point at Brand
  fonts: > “The font name was read from the font file itself.”

## 2:45 — Start a real scan (45 s) — Scan tab
Tick “I am authorized…”, **Start QA Scan**. > “It crawls the site, opens every page in a real
browser at desktop, tablet and phone size, and runs each check.” Let it run in the background;
switch to the scan prepared earlier (tab c).

## 3:30 — A genuine design issue (2 min) — tabs (c) → (d)
- Scan page: every step **Completed**; the AI step says **Skipped** if AI is off (say why).
- **Comparison → Design comparison:** “Heading 1 font size — expected 48px (from the guideline, with
  the line), found 40px on /about.” > “The expected value comes from our document, the actual value
  from the browser — nothing is guessed.” Show “Unable to verify” items: > “Where there is no
  reference value, it says so instead of inventing one.”
- **Design Quality** section: the six parts and what each checked.
- Open issue (d): **In plain language** → **Where** → **How to fix** (example code) → **How to verify**.
  > “Chromium's own font engine reports which font actually drew the text: the page asks for
  Geist Display, but the file does not exist, so visitors see a substitute.”
- Expand **Technical details and evidence**: raw finding, measured values, screenshot.

## 5:30 — Content and other checks (1 min)
- Comparison → Content comparison: “Book a consultation” vs approved “Book a free consultation”, and
  a missing approved paragraph; 28 other blocks matched.
- Issues list: accessibility (missing label), SEO (missing description), broken link (404),
  responsive (banner too wide on phones). > “Same evidence and plain-language guide for every
  category.”

## 6:30 — Fix and re-scan (1.5 min)
Run in a terminal: `Invoke-RestMethod -Method Post -Uri http://localhost:4100/__demo/variant -Body fixed`
> “This simulates the developers deploying fixes.” Start a scan; while it runs show **Scan
history**. When finished, open the comparison: issues **Resolved** vs **Persistent**. > “A fix
only counts as resolved when a new scan no longer finds it.”
(If time is short, show the comparison prepared in advance instead.) Afterwards run the same
command with `-Body original`.

## 8:00 — Reports and honest limitations (1 min)
- Reports tab: PDF / Markdown / JSON with every finding and its evidence.
- Limitations to say plainly:
  - Image clarity is judged from image size vs display size, not by analysing the pixels for blur.
  - Spacing and alignment results are “needs review”, not automatic defects.
  - Figma: the live integration works (shown on the Ascendion project) but reads values (styles,
    colours, components), not page layouts; there is no automatic page-to-frame mapping.
  - AI writes issue text only when a provider is configured, and every AI sentence is checked
    against the evidence; without AI the built-in explanations are used.
  - This demo site is local and fictional; a real website works the same way (with permission to
    scan it).

## 9:00 — Close
> “Next steps: run it on one of our real staging sites, connect our Figma design system, and agree
> which findings should block a release.”

---

### Fallbacks
| If… | Then |
|---|---|
| The live scan is slow | Use the scan prepared in advance; say the live one is still running |
| AI is off or the daily quota is used | Say so; issues use built-in explanations (deterministic, evidence-based) |
| Figma is unavailable | Show `figma/FIGMA_DESIGN_SPEC.md` and the earlier successful read on the Ascendion project; do not claim a live read |
| A port is in use | Guide Step 2 → “Port already in use” |
