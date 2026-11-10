# Ascendion — Brand Guidelines (QA test reference)

Transcribed on 2026-10-22 for QA Copilot testing from Ascendion's design-system frames in the Figma file **Ascendion_Dev** (folder "Ascendion 4.0"), read through the Figma API:

- **UI_Kit** (node 313:3425, "Ascendion · Design System · V1") — breakpoints, grid, spacing, colours, typography, buttons.
- **Updated_UI_Kit** (node 7889:24666) — newer type and spacing values. Where both frames give a value, the Updated_UI_Kit value is used here; the website's own CSS also uses the updated values (H1 60px, H2 48px, H3 32px at desktop width).

Brand guideline link: https://www.figma.com/proto/Eav4PRP1fmlGFbjO0u0agY/Ascendion_Dev?node-id=313-3425&page-id=228%3A1204

All values are desktop values (1440px design width) unless a table says otherwise. This document is a faithful transcription for testing, not an official Ascendion publication.

## 1. Colour palette

The kit's rule: "Four colors. Nothing else." Brand colours first, then the neutral greys.

Brand Black — #000000

Brand White — #FFFFFF

Brand Neural Mint — #00FAC2

Brand Dark Teal — #008567

Neutral Soft Grey — #F4F4F4

Neutral Light Grey — #CCCCCC

Neutral Medium Grey — #999999

Neutral Slate Grey — #666666

Neutral Charcoal — #333333

Neutral Deep Black — #1A1A1A

Transparency tokens (overlays only, not separate colours): white at 20% and 60%; black at 10%, 20%, 30%, 40%, 60% and 80%; deep-black at 60%.

## 2. Typography

Heading font: PP Neue Machina

Body font: IBM Plex Sans

Two faces, one system. PP Neue Machina is the primary typeface (headlines, display, brand voice); IBM Plex Sans is the secondary typeface (body, UI, captions, numbers). IBM Plex Sans is distributed with these guidelines under the SIL Open Font License; PP Neue Machina is a commercial typeface (Pangram Pangram Foundry) and is not included.

### Heading hierarchy (desktop)

H1 — PP Neue Machina Regular, 60px / 76px, letter spacing 0px

H2 — PP Neue Machina Regular, 48px / 56px, letter spacing 0px

H3 — PP Neue Machina Regular, 32px / 40px, letter spacing 0px

H4 — PP Neue Machina Regular, 40px / 48px, letter spacing 0px

H5 — PP Neue Machina Regular, 32px / 40px, letter spacing 0px

H6 — PP Neue Machina Regular, 24px / 32px, letter spacing 0px

The kit names the weight of every Display style "Plain Regular". H1 and H2 use Title Case; H3 to H6 use Sentence case. H1–H3 come from the Updated_UI_Kit; H4–H6 were not updated there and keep their UI_Kit values, so H4 (40px) is larger than H3 (32px) in the kit as it stands.

### Body and interface text (desktop)

Body text — IBM Plex Sans Light, 18px / 26px, letter spacing 0px

Button text — IBM Plex Sans Medium, 18px / 26px, letter spacing 0px

Body text is the kit's Body/Body-S style (running paragraphs). Button text is the kit's Body/CTA style, used by the "Connect" call-to-action buttons.

## 3. Full type scale (reference)

Values are size / line height / letter spacing for Desktop · Tablet · Mobile.

Display family — PP Neue Machina, Plain Regular:

| Style | Desktop | Tablet | Mobile | Case | Source |
|---|---|---|---|---|---|
| Display/Dis 1 | 80 / 88 / 0% | 64 / 72 / 0% | 48 / 56 / 0% | Title Case | UI_Kit |
| Display/H1 | 60 / 76 / 0% | 44 / 56 / 0% | 32 / 40 / 0% | Title Case | Updated_UI_Kit |
| Display/H2 | 48 / 56 / 0% | 40 / 52 / 0% | 28 / 36 / 0% | Title Case | Updated_UI_Kit |
| Display/H3 | 32 / 40 / 0% | 28 / 40 / 0% | 20 / 28 / 0% | Sentence case | Updated_UI_Kit |
| Display/H4 | 40 / 48 / 0% | 36 / 48 / 0% | 24 / 32 / 0% | Sentence case | UI_Kit |
| Display/H5 | 32 / 40 / 0% | 28 / 40 / 0% | 20 / 28 / 0% | Sentence case | UI_Kit |
| Display/H6 | 24 / 32 / 0% | 22 / 32 / 0% | 18 / 26 / 0% | Sentence case | UI_Kit |

Body family — IBM Plex Sans:

| Style | Weight | Desktop | Tablet | Mobile | Source |
|---|---|---|---|---|---|
| Body/Body-XL | Regular | 32 / 40 / 0% | 28 / 40 / 0% | 28 / 36 / 0% | UI_Kit |
| Body/Body-L | Regular | 22 / 32 / 0% | 20 / 32 / 0% | 18 / 26 / 0% | Updated_UI_Kit |
| Body/Body-M | Light | 24 / 32 / 0% | 20 / 32 / 0% | 20 / 28 / 0% | UI_Kit |
| Body/Body-S | Light | 18 / 26 / 0% | 16 / 24 / 0% | 16 / 24 / 0% | Updated_UI_Kit |
| Body/Body-XS | Regular | 18 / 26 / 0% | 16 / 24 / 0% | 16 / 24 / 0% | UI_Kit |
| Body/Body-XXS | Regular | 16 / 24 / 0% | 14 / 20 / 0% | 14 / 20 / 0% | UI_Kit |
| Body/Caption | Bold | 12 / 20 / 1% | 12 / 16 / 1% | 12 / 16 / 1% | UI_Kit |
| Body/Tags | Bold | 14 / 20 / 1% | 12 / 16 / 1% | 12 / 16 / 1% | Updated_UI_Kit |
| Body/CTA | Medium | 18 / 26 / 0% | 16 / 24 / 0% | 16 / 24 / 0% | both |

Weight tokens: plain-ultrabold 800, plain-regular 400, medium 500, bold 700, regular 400, light 300, semibold 600.

## 4. Layout, grid and spacing

Breakpoints: Desktop 1440px reference width (CSS threshold 1024px and up), Tablet 820px (720–1023px), Mobile 402px (0–719px).

Layout grid (full-bleed): Desktop 12 columns, margin 60px, gutter 20px (or a fluid 4.2% margin); Tablet 8 columns, margin 40px, gutter 16px (fluid 5%); Mobile 4 columns, margin 20px, gutter 12px (fluid 5%).

Spacing primitives (15): 0, 4, 8, 12, 14, 16, 20, 24, 26, 32, 40, 48, 60, 80 and 120 pixels.

Module top and bottom padding: 60px desktop, 48px tablet, 32px mobile. Spacing between a title and its content: 32px desktop, 26px tablet, 20px mobile (Updated_UI_Kit).

Page banners: banner height is 60% of the viewport height on all pages and all devices (Updated_UI_Kit).

## 5. Buttons

"Two CTAs. One verb." The primary call to action ("Connect") uses the Body/CTA text style (18px / 26px Medium on desktop, 16px / 24px on tablet and mobile; touch interfaces have no hover state).

Variants in the kit: light-background buttons, dark-background buttons, text-only links with an arrow (Dark Teal arrow on light backgrounds, Neural Mint arrow on dark backgrounds), and arrow-only buttons. The arrow block of the primary button is Neural Mint.
