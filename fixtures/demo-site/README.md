# Demo fixture site

A small, fully controlled website used by integration tests, end-to-end tests and demo mode.
Results produced from it are test/demo data and must never be presented as a real website's QA.

Run: `npm run demo:site` (http://localhost:4100). `localhost:4100` is in the default
`SCAN_ALLOWED_PRIVATE_HOSTS` so it can be scanned locally.

| Path | Behavior (intentional) |
|---|---|
| `/` | Home; links below; console error; 300 KB image; one link added only by JavaScript (`/js-only`) |
| `/about?utm_source=newsletter` | Same page as `/about` after URL normalization (tracking parameter) |
| `/old-page` | 301 → `/about` |
| `/chain-start` | 302 → `/chain-mid` → 301 → `/products` (redirect chain) |
| `/private/secret` | Disallowed by `robots.txt` |
| `/missing` | 404 |
| `/server-error` | Always 500 (retried, then reported) |
| `/docs/guide.pdf` | Non-page resource: linked but not crawled as a page |
| `https://example.org/partner` | External link: never crawled |
| `/products` → `/products/widget`, `/products/gadget` | Depth 2 |
| `/blog/` → `/blog/post-1` → `/blog/archive` → `/blog/archive/2019` | Depths 1–4 (depth 4 exceeds the default limit of 3) |
| `/contact` | Form with an unlabeled input (accessibility fixture for Phase 5) |
| `/robots.txt` | `Disallow: /private/`, sitemap reference |

No framework or CMS signals are served, so technology detection should report
"Could not determine".
