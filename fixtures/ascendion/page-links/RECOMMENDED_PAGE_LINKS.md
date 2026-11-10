# Ascendion — page links to add for this test

Add these in the project wizard (Step 2 → **Page links** → **+ Add page**, one at a time) or later
under **References → Page links**. All returned HTTP 200 on 2026-10-22.

```
https://ascendion.com/ai-basic/why-enterprise-agentic-ai-stalls-before-production/
https://ascendion.com/ai-basic/agentic-quality-engineering-from-test-automation-to-autonomous-assurance/
https://ascendion.com/ai-basic/enterprise-platform-services-reimagined-ai-in-the-erp-crm-and-core-platform-layer/
https://ascendion.com/ai-basic/gcc-to-the-power-of-ai-the-ai-native-global-capability-center/
https://ascendion.com/ai-basic/modernization-sequencing-which-systems-to-modernize-first-when-ai-changes-the-cost-curve/
https://ascendion.com/newsroom/ai-basics/
https://ascendion.com/
```

Why these seven:

| Page | Why it is in the test |
|---|---|
| Why Enterprise Agentic AI Stalls Before Production | The page the content document (PDF) was written for: content comparison runs here. |
| The four "Related AI Basics" articles | Linked from the test article and built on the same article template, so the design comparison (Figma T16 article template + brand guidelines) is checked on five pages of one template: real inconsistencies stand out, one-off differences do not. |
| /newsroom/ai-basics/ | The AI Basics listing. The article's breadcrumb links to `/ai-basic`, which redirects here; the links scanner follows it. |
| Home page | The site's main page, so the security, SEO, performance and accessibility results cover more than one template. |

Notes
- The full list of 337 working pages is in `ALL_PAGE_LINKS.md` / `all-page-links.txt`. Page links are
  not limited by the maximum page count, so adding hundreds of them makes one very long scan.
- In Step 3 keep **Max pages 10** and **Max link depth 1**: the crawler then adds a few pages it finds
  from the home page on top of these seven.
