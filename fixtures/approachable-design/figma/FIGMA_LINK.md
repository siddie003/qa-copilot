# Approachable Design — Figma design link (Newsletter page only)

Paste into QA Copilot → New project → Step 2 → **Figma design URL** (or References → Add Figma link):

```
https://www.figma.com/design/uJ27pZGYseRcxbeab1VWRA/Approachable-Design---Newsletter-page--QA-test-?node-id=1-12
```

- File “Approachable Design - Newsletter page (QA test)” (key `uJ27pZGYseRcxbeab1VWRA`), in the
  Drafts of siddharthhattiholi07@gmail.com, created 2026-10-17. `node-id=1-12` is the frame
  “Newsletter – Desktop 1440” on page “Newsletter”. Only this one page is designed.
- Built from the live page's measured styles; placeholder text only (the site's copy is not copied).
- What QA Copilot reads from it:
  - Text styles: **Body** Inter Regular 18/28.8 · **H4** Manrope SemiBold 14/20, letter spacing 0.7 ·
    **Button** Manrope SemiBold 16/24 · **Navigation link** Manrope Medium 15/24 · **Lead** Inter
    Regular 20/28 (no website role; reported as skipped).
  - Colour styles: Primary text #0B0A16, Page background #FFECE2, Header background #FFECE2,
    Brand purple #5148CA, Button text #FFFFFF.
  - Component `Button / Variant=Primary`: Brand purple, white Manrope SemiBold 16, padding 24/16,
    corner radius 9999 (the site uses ≈22,369,600px; both draw a pill, but the numbers differ, so
    the radius comparison reports a difference).
  - Frame `Container`: 1200px.
- Headings H1/H2 are drawn in Playfair Display Black Italic as a visual **stand-in** without a text
  style, because the real font (Domaine Display Black Italic, commercial) is not available in
  Figma. QA Copilot therefore reads no heading values from Figma; it takes them from the brand
  guidelines document.
- Token: the token in `.env` can open this file only as a viewer (low Figma rate limit, currently
  exhausted). For reliable reads, generate a token in siddharthhattiholi07@gmail.com (scope File
  content: Read) and save it on the project's References page → Figma token.
