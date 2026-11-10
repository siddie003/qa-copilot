# Ascendion — Figma design URL for this test

Paste this into the project wizard, Step 2 (**Figma / brand**) → **Figma design URL**:

```
https://www.figma.com/design/Eav4PRP1fmlGFbjO0u0agY/Ascendion_Dev?node-id=3176-16686
```

| | |
|---|---|
| File | Ascendion_Dev (folder "Ascendion 4.0"), file key `Eav4PRP1fmlGFbjO0u0agY` |
| Frame | **T16-Insight Inner**, node `3176:16686`, 1440 × 9495 px (desktop), on the **Prototypes** page — the page your prototype link opens |
| Matches | the insights/AI-basics article template used by https://ascendion.com/ai-basic/why-enterprise-agentic-ai-stalls-before-production/ and its four related articles (hero with breadcrumb, article body, table-of-contents sidebar, related cards) — compared side by side in a browser on 2026-10-22 |
| Chosen on | 2026-10-22, approved by you |

## Why this frame and not the others

The file has 53 Figma pages (templates T1–T35, microsites, a mega menu, a design system). QA Copilot
reads **one Figma link per project**, and each extraction costs **one Figma file read**. Your
account has a viewer seat on this file, which Figma limits to roughly 20 file reads a month.
So the test uses the one frame that matches the pages being tested:

| Frame | Node | Used? |
|---|---|---|
| T16-Insight Inner (desktop) | 3176:16686 | **Yes**: article template = the test page |
| T16-Insight Inner Mobile | 4794:39154 | No: QA Copilot compares the desktop design |
| T2-AAVA_option_00 (your prototype link) | 9562:5216 | No: it is the AAVA product page (/aava/), not the article |
| UI_Kit / Updated_UI_Kit | 313:3425 / 7889:24666 | Already transcribed into `../brand/ascendion-brand-guidelines.md` (no Figma read needed when testing) |
| T1 Home, T15 Insights listicle, other templates | — | Not needed for this test; each would need its own project and read |

## Figma reads used so far (October 2026)

- Preparing this folder on 2026-10-22: **2 reads** (file page list; the two UI kit frames).
- Each **Extract again** on the Figma source: 1 read. A second read of an unchanged file costs none
  (QA Copilot checks the version first).

## When you test

1. The Figma token is already in `.env` (`FIGMA_ACCESS_TOKEN`); nothing to add.
2. After the project is created, open **References**. Wait until the Figma source and the brand
   guideline both show **Ready**, review the draft, then click **Confirm draft**. Only then start the
   scan. Without a confirmed draft the design comparison is skipped.
3. Heading styles in this file come from Ascendion's shared design library. If the Figma read
   reports a value it could not use, the brand guidelines still provide H1–H6, body and button
   values.
