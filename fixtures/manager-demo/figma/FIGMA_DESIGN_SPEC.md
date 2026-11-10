# Brightline Studio — Figma-ready design specification

**Status: not a Figma file.** This is a specification you can rebuild in Figma. No Figma file for
the demo website exists yet, and one cannot be created through Figma's REST API (it can read files,
not create them). Do not paste this file's path into the Figma field.

What exists today (verified from the app's own records, not re-read on 2026-10-14):
- Your real file “Ascendion_Dev”: `https://www.figma.com/proto/Eav4PRP1fmlGFbjO0u0agY?node-id=9562-5216`,
  read successfully by QA Copilot's live Figma integration on 2026-10-11. It is unrelated to the
  Brightline demo design.

## What QA Copilot reads from a Figma file (current implementation)

`packages/reference/src/figma/normalize.ts` reads, from the linked page/frame:
- **Local text styles** → typography roles by name: a name containing `H1`…`H6` (or
  `Heading 1`), `Body`/`Paragraph`, `Link`, `Button`.
- **Local colour styles** → palette; conventional names get roles (“Primary text”, “Link”,
  “Page background”, “Header background”, “Footer background”).
- **Components named `Button`** with a `Primary` / `Secondary` variant → button colours, radius,
  padding, text size and weight.
- **A frame named `Container`** → content container maximum width.

It does **not** map Figma frames to website pages; values are project-wide. Extracted values become a
draft that you confirm on the References page.

## Build it in Figma (about 20 minutes)

1. In Figma: **New design file**, name it `Brightline Studio – Website`.
2. Add the font: Geist is available in Figma's font list (or install
   `fixtures/manager-demo/fonts/Geist-Regular.ttf` locally / use the Figma font installer).
3. Create **colour styles** (Fill → Style → +) with exactly these names and values:

   | Style name | Value |
   |---|---|
   | Brand blue | #1A56DB |
   | Primary text | #1F2937 |
   | Heading | #111827 |
   | Link | #1A56DB |
   | Page background | #FFFFFF |
   | Header background | #F3F4F6 |
   | Footer background | #111827 |
   | Border grey | #E5E7EB |

4. Create **text styles** (Text → Style → +), all Geist, colour Heading (#111827) for headings:

   | Style name | Weight | Size | Line height |
   |---|---|---|---|
   | H1 | Bold (700) | 48 | 56 |
   | H2 | Semi Bold (600) | 32 | 40 |
   | H3 | Semi Bold (600) | 24 | 32 |
   | H4 | Semi Bold (600) | 20 | 28 |
   | Body | Regular (400) | 16 | 24 |
   | Button | Semi Bold (600) | 16 | 24 |

5. Create a component named **`Button`** with a variant property `Variant=Primary`: auto layout,
   padding 12 top/bottom and 24 left/right, corner radius 8, fill Brand blue, text style Button in
   white (#FFFFFF).
6. Create a frame named **`Container`**, width 1200.
7. Create one page **`Website`** with frames `Home – 1440`, `About – 1440`, `Services – 1440`,
   `Contact – 1440` (1440 wide) laid out with the styles above (optional for the app, useful for
   people).
8. Share: keep the file in a team/project where your account has edit or view access. The token in
   `.env` must belong to an account that can open the file and needs the scope
   `file_content:read` (the current token has it).
9. Copy the link: select the `Website` page (or the frame that contains the styles), then **Share →
   Copy link**. A `design/<key>/…?node-id=…` link reads only that node (cheapest); a link without
   `node-id` reads the whole file page by page.

## Use it in QA Copilot

- Paste the link into **Step 2 → Figma design URL (optional)** when creating the project, or later
  on **References → Add a Figma file or frame link → Add Figma link**.
- Check that it was really read: References → the Figma source shows **Ready** (or Partial with the
  reason), the file name, the pages/frames read and the request counts; the draft lists each value
  with “Figma … (node …)” as its source. If the token is missing or lacks access, the source shows
  **Unavailable** or **Failed** with Figma's reason; nothing is invented.
- Confirm the draft only if the values are right. Brand-guideline and Figma values are merged into
  one draft; Figma values can replace guideline values for the same items.
- Figma's API is rate limited per seat type; a viewer seat gets few file reads per month. Avoid
  repeated “Extract again” clicks during a demo.
