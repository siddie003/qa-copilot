# Demo fixture site

A small, fully controlled website used by integration tests, end-to-end tests and demo mode.
Every defect below is intentional, so each scanner can be verified against known ground truth.
Results produced from it are test/demo data and must never be presented as a real website's QA.

Run: `npm run demo:site` (http://localhost:4100). `localhost:4100` is in the default
`SCAN_ALLOWED_PRIVATE_HOSTS`, so it can be scanned locally. Use `http://localhost:4100`.

## Crawl behaviors

| Path | Behavior |
|---|---|
| `/` | Home; console error; 360 KB PNG; one link added only by JavaScript (`/js-only`) |
| `/about?utm_source=newsletter` | Same page as `/about` after URL normalization |
| `/old-page` | 301 → `/about` (redirect duplicate; analyzed once) |
| `/chain-start` | 302 → `/chain-mid` → 301 → `/products` (redirect chain) |
| `/private/secret` | Disallowed by `robots.txt` |
| `/missing` | 404 |
| `/server-error` | Always 500 |
| `/members`, `/members/profile` | HTTP Basic authentication (`qa` / `demo-pass`); 401 without credentials |
| `/slow` | Answers after 1.5 s |
| `/docs/guide.pdf` | Non-page resource: linked but not crawled as a page |
| `https://example.org/partner` | External link: never crawled, but link-checked |
| `/blog/archive/2019` | Depth 4 (beyond the default depth limit of 3) |

## Intentional defects per scanner

| Scanner | Defect | Where |
|---|---|---|
| Accessibility | Image without alt | `/about` |
| Accessibility | Input without label; icon button without name | `/contact` |
| Accessibility | Low-contrast text (#c4c4c4 on white) | `/products` |
| Accessibility | Skipped heading levels | `/blog/post-2` |
| Security | Plain HTTP; no CSP, frame protection, nosniff, Referrer/Permissions-Policy | site-wide |
| Security | `Server: DemoServer/1.2.3` version disclosure | site-wide |
| Security | Cookie `demo_session` without HttpOnly/SameSite | `/` |
| Security | AWS documentation example key in an HTML comment | `/` |
| SEO | Missing meta description | `/about` |
| SEO | Duplicate title “Product” | `/products/widget`, `/products/gadget` |
| SEO | Two H1s | `/blog/post-2` |
| SEO | Invalid JSON-LD | `/` |
| SEO | Sitemap declared in robots.txt but missing | `/sitemap.xml` |
| Links | Broken internal links (404, 500), redirect chain, broken image | `/`, `/products/gadget` |
| Performance | 1.5 s TTFB | `/slow` |
| Performance | 360 KB image; render-blocking script and stylesheet | `/` |
| Responsive | 1100 px wide banner (horizontal overflow); clipped text | `/wide` |
| Responsive | 16 px button; overlapping links | `/contact` |
| Responsive | 1200 px image without max-width (overflow on mobile/tablet) | `/` |

No framework or CMS signals are served, so technology detection reports "Could not determine"
(the `Server` header is reported separately as server software).

## Design and content references

`fixtures/documents/design-spec.json` (design reference) and
`fixtures/documents/approved-content.md` (approved content) describe what the site *should* look
like and say. The site differs from them on purpose; the expected comparison results are asserted
by the pipeline integration test and the references end-to-end test.

### Design (`/assets/site.css` vs `design-spec.json`)

| Reference value | Site | Expected verdict |
|---|---|---|
| H1 Georgia, 700, #1A1A2E | same | match |
| H1 48px | 40px | confirmed mismatch (compared at the widest viewport) |
| Body text Inter | system-ui | confirmed mismatch |
| Body 16px, text #222222, page #FFFFFF | same | match |
| Text #222222 | `/products` paragraph is #C4C4C4 | confirmed mismatch |
| Link #1A56DB | #0645AD (ΔE 7.86) | confirmed mismatch |
| Header background #E2E8F0 | #F1F5F9 (ΔE 3.36) | potential mismatch |
| Primary button #1A56DB, radius 8px | `.btn-primary` #1D4ED8 (ΔE 2.61), 6px; found by class name only | potential mismatch |
| Primary button text #FFFFFF, padding 24px/12px | same | match |
| H3 20px; secondary button; container 1200px | no such element / no confident mapping | unable to verify |

### Content (`approved-content.md` vs page text)

| Approved block | Mapping | Expected verdict |
|---|---|---|
| “Contact”, “We reply within one business day.” | heading similarity → `/contact` | match; missing (potential: mapping not explicit) |
| “About us”, “We sell demo products.” | `<!-- page: /about -->` | match |
| “… every single week.” | `/about` | changed wording (confirmed) |
| “Our Mission” | `/about` | capitalization differs (potential) |
| “Free shipping on all orders over $50.” | `/about` | missing (confirmed) |
| CTA “Contact our team” → `/contact` | `/about` | link target differs: site links to `/blog/` (confirmed) |
| “Products”, “Prices include VAT.” | `Page: Products` | match |
| “… widgets and gadgets today.” | `Page: Products` | changed wording (potential: name mapping) |
| “Join our team”, “We are always looking …” | `Page: Careers` (no such page) | unable to verify |
