# Brand font files (Geist)

| File | Format | What it contains | Used by the demo website |
|---|---|---|---|
| `Geist-Variable-Latin.woff2` | WOFF2 (variable, weights 100–900, Latin subset) | Family “Geist” | Yes: served at `/fonts/geist-variable-latin.woff2` and used for every heading, paragraph, link and button style (`@font-face` in `site/server.mjs`) |
| `Geist-Regular.ttf` | TrueType, static Regular 400 | Family “Geist” | Not served; uploaded to QA Copilot as a second brand font file |

- **Licence:** SIL Open Font License 1.1, copyright 2024 The Geist Project Authors
  (https://github.com/vercel/geist-font). Full text: [OFL.txt](OFL.txt). The licence statement is
  also embedded in the files' own name table (name IDs 0, 13, 14).
- **Source:** copied unmodified from this repository's installed `next` package
  (`node_modules/next/dist/next-devtools/server/font/geist-latin.woff2` and
  `node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf`).
  SHA-256: woff2 `1b5ebfb3…995ba8`, ttf `bde046dd…871d76`.
- **Upload:** New project → Step 1 → **Font files (optional)** → choose both files (or later:
  References → Brand fonts → Upload font files). After upload the app shows “Font file read:
  “Geist” Regular” — the name comes from the file itself.
- **What the app does with them:** QA Copilot never adds the fonts to the website. The Design
  Quality & Typography scanner (1) compares the font family the site's headings and body text ask
  for with the uploaded families, and (2) asks Chromium's font engine which font actually drew a
  sample of headings and paragraphs (widest screen size). The design comparison separately compares
  font families with the confirmed design reference.
- **Check in a browser yourself:** open `http://localhost:4100`, press F12 → Console and run
  `document.fonts.forEach(f => console.log(f.family, f.status))` → `Geist loaded`. Or Elements →
  select the H1 → Computed → scroll to **Rendered Fonts** → “Geist — Network resource”.
