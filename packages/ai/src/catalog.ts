/**
 * Rule catalog: deterministic remediation guidance per scanner rule. Used for issues without AI
 * text, given to the AI as the basis for its recommendation, and part of the grounding corpus
 * (values written here are vetted, so the AI may repeat them).
 */

export interface RemediationContext {
  ruleId: string;
  /** Expected value shared by all findings of the issue, if any. */
  expected: string | null;
  /** Actual value shared by all findings of the issue, if any. */
  actual: string | null;
  /** Rule documentation linked from the evidence (axe-core). */
  helpUrl: string | null;
  /** Design token path (design comparison), e.g. typography.h1.fontSize. */
  token: string | null;
  /** Where the reference value comes from (design token source or document location). */
  source: string | null;
}

type Fix = (c: RemediationContext) => string;

const quoted = (v: string | null) => (v ? `“${v}”` : "the approved text");

/** Specific accessibility guidance, followed by the axe-core rule documentation when available. */
const axe =
  (text: string): Fix =>
  (c) =>
    c.helpUrl ? `${text} Rule documentation: ${c.helpUrl}` : text;

const ACCESSIBILITY: Record<string, Fix> = {
  "focus-indicator-visible": () =>
    "Give every focusable element a clearly visible focus style, for example an outline or box-shadow in a :focus-visible rule, and never remove the browser's default outline (outline: none) without a replacement. Check the listed elements by moving through the page with the Tab key.",
  "image-alt": axe(
    'Add an alt attribute to each listed image: a short description of what the image shows or does for content images, and alt="" for purely decorative images. An image inside a link or button should describe where the link goes or what the button does.',
  ),
  "color-contrast": axe(
    "Darken the text or lighten the background (or the reverse) until the contrast ratio reaches at least 4.5:1 for normal text and 3:1 for large text. Change the color in the shared style (design token or CSS variable) so every use is fixed.",
  ),
  "link-name": axe(
    'Give each listed link text that says where it goes. For icon-only links add an aria-label (for example aria-label="Open the cart") or visually hidden text.',
  ),
  "button-name": axe(
    'Give each listed button a visible text label, or an aria-label for icon-only buttons (for example aria-label="Close").',
  ),
  label: axe(
    'Connect a visible label to each listed form field (<label for="field-id"> or by wrapping the field in the label). A placeholder is not a label.',
  ),
  "html-has-lang": axe(
    'Add the page language to the <html> element, for example <html lang="en">.',
  ),
  "document-title": axe("Add a <title> element that describes the page to its <head>."),
  "heading-order": axe(
    "Use heading levels in order without skipping a level (h1, then h2, then h3); change the heading tags, not only their size.",
  ),
  "target-size": axe(
    "Make the listed links and buttons at least 24×24 CSS pixels, or leave enough space around them so they do not overlap neighbouring targets.",
  ),
  region: axe(
    "Place all page content inside landmark elements: <header>, <nav>, <main> and <footer> (or the matching ARIA roles).",
  ),
  "landmark-one-main": axe("Wrap the page's main content in a single <main> element."),
};

const accessibilityDefault: Fix = (c) =>
  [
    `Fix each listed element so it passes the axe-core rule “${c.ruleId}”${c.expected ? `: ${c.expected}` : ""}.`,
    c.helpUrl
      ? `The rule documentation explains the requirement and common fixes: ${c.helpUrl}`
      : "",
    "Re-test the page with the keyboard and a screen reader after the change.",
  ]
    .filter(Boolean)
    .join(" ");

const SECURITY: Record<string, Fix> = {
  "https-not-used": () =>
    "Serve the whole site over HTTPS: install a TLS certificate, redirect every http:// request to https:// with a permanent (301 or 308) redirect, then enable HSTS.",
  "http-not-redirected": () =>
    "Configure the web server or CDN to answer every plain-HTTP request with a permanent redirect (301 or 308) to the same URL on https://.",
  "hsts-missing": () =>
    "Send the Strict-Transport-Security header on every HTTPS response, for example “Strict-Transport-Security: max-age=15552000; includeSubDomains”. Add includeSubDomains only if every subdomain supports HTTPS.",
  "hsts-weak": () =>
    "Raise the HSTS max-age to at least 15552000 seconds (180 days); 31536000 (one year) is common once HTTPS works everywhere.",
  "csp-missing": () =>
    "Define a Content-Security-Policy header. Start with a restrictive policy (for example default-src 'self'; object-src 'none'; base-uri 'self'), run it as Content-Security-Policy-Report-Only to find violations, then enforce it.",
  "csp-unsafe-script": () =>
    "Remove 'unsafe-inline', 'unsafe-eval', wildcards and bare scheme sources from script-src (or default-src). Move inline scripts into files, or allow the ones you need with nonces or hashes.",
  "x-content-type-options-missing": () =>
    "Send “X-Content-Type-Options: nosniff” on every response.",
  "frame-protection-missing": () =>
    "Stop other sites from framing the pages: send the CSP directive frame-ancestors 'self' (or 'none'), plus “X-Frame-Options: DENY” or SAMEORIGIN for older browsers.",
  "referrer-policy-unsafe": () =>
    "Set Referrer-Policy to strict-origin-when-cross-origin (or no-referrer / same-origin) so full URLs are not sent to other sites.",
  "referrer-policy-missing": () =>
    "Send an explicit Referrer-Policy header, for example “Referrer-Policy: strict-origin-when-cross-origin”.",
  "permissions-policy-missing": () =>
    "Send a Permissions-Policy header that disables browser features the site does not use, for example camera=(), microphone=(), geolocation=().",
  "server-version-disclosure": () =>
    "Remove version numbers from the Server header and stop sending X-Powered-By and X-AspNet-Version in the web server or framework configuration.",
  "cookie-flags": () =>
    "Set the missing attributes where the application creates the listed cookies: Secure (sent over HTTPS only), HttpOnly (not readable by scripts, unless client-side code must read the cookie) and SameSite=Lax or Strict.",
  "insecure-form-action": () =>
    "Change the form's action to an https:// URL (or a relative URL on the HTTPS site) so the submitted data is encrypted.",
  "sri-missing": () =>
    'Add integrity (a sha384 hash of the exact file) and crossorigin="anonymous" attributes to the listed third-party scripts and stylesheets, or host the files yourself.',
};

const exposedSecret: Fix = () =>
  "Check whether the value is a real credential. If it is, revoke and rotate it immediately, remove it from the page source and build output, and keep secrets on the server only.";

const SEO: Record<string, Fix> = {
  "title-missing": () => "Add a unique, descriptive <title> element to the page's <head>.",
  "title-length": () =>
    "Rewrite the title to about 10–60 characters, with the most important words first.",
  "meta-description-missing": () =>
    'Add <meta name="description" content="…"> with a unique summary of about 50–160 characters to each listed page.',
  "meta-description-length": () =>
    "Rewrite the meta description to about 50–160 characters that summarize the page.",
  "h1-missing": () => "Add one <h1> that describes the page's main topic.",
  "h1-multiple": () =>
    "Keep a single <h1> for the page's main topic and change the other top-level headings to <h2> or lower.",
  "heading-level-skipped": () =>
    "Use heading levels in order (h1, then h2, then h3) without skipping a level; change the heading tags, not only their size.",
  noindex: () =>
    "If the page should appear in search results, remove noindex from the robots meta tag and the X-Robots-Tag header. If the page is meant to stay out of search results, no change is needed.",
  "canonical-multiple": () =>
    'Keep exactly one <link rel="canonical"> per page, pointing to the preferred URL.',
  "canonical-missing": () =>
    'Add <link rel="canonical" href="…"> pointing to each page\'s preferred URL.',
  "html-lang-missing": () =>
    'Add the page language to the <html> element, for example <html lang="en">.',
  "viewport-meta-missing": () =>
    'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>.',
  "img-alt-attribute-missing": () =>
    'Add an alt attribute to every <img>: a short description for content images and alt="" for purely decorative ones.',
  "structured-data-invalid": () =>
    "Fix the JSON syntax of the listed JSON-LD block (check it with a JSON or structured-data validator) so search engines can read it.",
  "structured-data-absent": () =>
    "Add relevant schema.org JSON-LD (for example Organization, Product or Article) to the pages that describe those things.",
  "title-duplicate": () => "Give each page its own title that describes its specific content.",
  "meta-description-duplicate": () => "Write a unique meta description for each page.",
  "open-graph-missing": () =>
    "Add og:title, og:description and og:image meta tags so shared links get a proper preview.",
  "url-structure": () =>
    "Use short, lowercase, hyphen-separated URLs, and redirect (301) the old URLs to the new ones.",
  "robots-txt-missing": () =>
    "Publish a robots.txt at the site root that allows crawling and references the XML sitemap.",
  "sitemap-not-found": () =>
    "Publish the sitemap at the URL declared in robots.txt, or correct the Sitemap line in robots.txt.",
  "sitemap-invalid": () =>
    "Fix the sitemap so it is well-formed XML with a <urlset> (or <sitemapindex>) root element.",
  "sitemap-missing": () =>
    "Generate an XML sitemap of the site's indexable pages and reference it in robots.txt.",
};

const LINKS: Record<string, Fix> = {
  "broken-internal-link": () =>
    "Fix or remove the links to the listed URLs: point them to existing pages, or restore the missing pages (or redirect them).",
  "broken-external-link": () => "Update the listed external links to working URLs, or remove them.",
  "link-temporarily-unavailable": () =>
    "Re-check the listed links later; if they keep failing, replace or remove them.",
  "redirect-chain": () =>
    "Link directly to the final URL so visitors and search engines skip the redirects.",
  "internal-link-redirects": () => "Update the internal links to point directly to the final URL.",
  "failed-resource": () =>
    "Fix the listed resource URLs (missing files, wrong paths or server errors) or remove the references to them.",
  "mixed-content-active": () =>
    "Load the listed scripts, stylesheets and other active resources over https://; browsers block them on HTTPS pages.",
  "mixed-content-passive": () =>
    "Load the listed images and media over https://, or host them on the site itself.",
};

const PERFORMANCE: Record<string, Fix> = {
  "lcp-slow": () =>
    "Speed up the largest content element: optimize and preload the main image, reduce render-blocking CSS and JavaScript, and improve the server response time.",
  "cls-slow": () =>
    "Reserve space for images, embeds and ads (width and height or aspect-ratio), and do not insert content above existing content after the page has loaded.",
  "tbt-slow": () =>
    "Reduce main-thread work: split and defer JavaScript, remove unused code and break up long tasks.",
  "ttfb-slow": () =>
    "Reduce the server response time: cache pages (server cache or CDN), speed up slow back-end work and avoid unnecessary redirects.",
  "fcp-slow": () =>
    "Show content sooner: inline critical CSS, defer non-critical scripts and styles, and improve the server response time.",
  "page-weight": () =>
    "Reduce the total download size: compress images, remove unused scripts and styles, and lazy-load content below the fold.",
  "javascript-size": () =>
    "Reduce the JavaScript: remove unused libraries, split bundles by page and load non-critical scripts later.",
  "css-size": () => "Remove unused CSS and split the styles by page.",
  "request-count": () =>
    "Reduce the number of requests: bundle small files, inline very small assets and remove unnecessary third-party requests.",
  "image-oversized": () =>
    "Serve images close to their displayed size, with srcset and sizes for responsive images.",
  "image-large": () =>
    "Compress the listed images and use a modern format (WebP or AVIF) at the displayed size.",
  "render-blocking-resource": () =>
    "Add defer or async to the listed scripts, inline the critical CSS and load the remaining CSS without blocking rendering.",
};

const RESPONSIVE: Record<string, Fix> = {
  "horizontal-overflow": () =>
    "Make the listed elements fit the viewport: use max-width: 100% and flexible widths instead of fixed pixel widths, and let wide content (tables, code) scroll inside its own container.",
  "text-clipped": () =>
    "Let the text wrap or give its container enough room; if truncation is intended, show an ellipsis and make the full text available.",
  "interactive-overlap": () =>
    "Separate the overlapping controls (spacing, layout or stacking order) so each one can be tapped or clicked on its own.",
  "tap-target-small": () =>
    "Make the touch targets at least 24×24 CSS px (44×44 recommended), or leave enough space around them.",
  "text-too-small-mobile": () =>
    "Use at least 16px for body text on mobile and never less than 12px.",
  "image-not-rendered": () =>
    "Replace the listed image files with valid images in a supported format, and check the Content-Type the server sends for them.",
  "mobile-nav-unreachable": () =>
    "Provide a visible menu button on small screens that reveals the navigation links.",
  "mobile-menu-broken": () =>
    "Fix the menu button so tapping it shows the navigation links (check its click handler and the CSS that hides the menu).",
};

const designMismatch: Fix = (c) =>
  `Update the styles of the listed elements so that ${c.token ?? "this design value"} is ${c.expected ?? "the value in the design reference"}${c.source ? ` as defined in the design reference (${c.source})` : " as defined in the design reference"}${c.actual ? `; the website currently uses ${c.actual}` : ""}. If the element mapping is wrong, add a CSS selector for this value in the design reference.`;

const DESIGN: Record<string, Fix> = {
  "design-color-near-palette": (c) =>
    `Check whether ${c.actual ?? "this color"} should be the brand color ${c.expected ?? "from the design reference"}. If it is a typo, replace it; if it is an intentional shade, add it to the design reference.`,
};

const CONTENT: Record<string, Fix> = {
  "content-missing": (c) =>
    `Add the approved text to the page exactly as written in the approved content${c.source ? ` (${c.source})` : ""}: ${quoted(c.expected)}.`,
  "content-changed-wording": (c) =>
    `Replace the website text with the approved wording${c.source ? ` (${c.source})` : ""}: ${quoted(c.expected)}.`,
  "content-different-wording": (c) =>
    `Review the text against the approved content${c.source ? ` (${c.source})` : ""} and use the approved wording if the change was not intended: ${quoted(c.expected)}.`,
  "content-capitalization": (c) =>
    `Match the capitalization of the approved text: ${quoted(c.expected)}.`,
  "content-link-target-mismatch": (c) =>
    `Change the link so that it matches the approved content: ${quoted(c.expected)}.`,
  "content-cta-not-link": (c) =>
    `Turn the text into a link or button as specified in the approved content: ${quoted(c.expected)}.`,
};

const DESIGN_QUALITY: Record<string, Fix> = {
  "dq-heading-inconsistent": () =>
    "Decide which of the measured styles is correct for this heading level and apply it to every heading of the level through one shared style or design token; remove one-off overrides.",
  "dq-heading-hierarchy-inverted": () =>
    "Make higher-level headings at least as large as lower-level ones, or change the heading levels so they match the visual importance (change the tag, not only the size).",
  "dq-webfont-not-rendered": () =>
    "Make the web font load: check the @font-face url() and format, that the font-family name matches exactly, that the font file contains the characters used, and that the font server allows the site's origin.",
  "dq-font-not-approved": (c) =>
    `Set the listed text in one of the uploaded brand fonts${c.expected ? ` (${c.expected.replace(/^One of the uploaded brand fonts: /, "")})` : ""}, or confirm that this font is allowed for it.`,
  "dq-image-upscaled": () =>
    "Serve the image at least at its displayed size (twice that for high-density screens), for example with srcset and sizes, or display it smaller.",
  "dq-image-distorted": () =>
    "Keep the image's proportions: remove fixed width/height values that do not match it, or use object-fit: cover to crop instead of stretching.",
  "dq-spacing-off-scale": () =>
    "Replace spacing values that are not on the design reference's spacing scale with the nearest scale value where the difference is not intentional, ideally through spacing tokens.",
  "dq-alignment-near-miss": () =>
    "Align the stacked elements on the same left edge, or make an intended indent clearly larger.",
  "dq-spacing-inconsistent": () =>
    "Space the repeated items evenly, preferably with the container's gap property instead of individual margins.",
};

const GENERIC: Fix = (c) =>
  c.expected
    ? `Change the listed elements so they meet the expected result: ${c.expected}.`
    : "Review the listed findings and their evidence, and fix the underlying cause.";

export function remediationFor(category: string, c: RemediationContext): string {
  const r = c.ruleId;
  switch (category) {
    case "accessibility":
      return (ACCESSIBILITY[r] ?? accessibilityDefault)(c);
    case "security":
      return (SECURITY[r] ?? (r.startsWith("exposed-secret-") ? exposedSecret : GENERIC))(c);
    case "seo":
      return (SEO[r] ?? GENERIC)(c);
    case "links":
      return (LINKS[r] ?? GENERIC)(c);
    case "performance":
      return (PERFORMANCE[r] ?? GENERIC)(c);
    case "responsive":
      return (RESPONSIVE[r] ?? GENERIC)(c);
    case "design":
      return (DESIGN[r] ?? designMismatch)(c);
    case "content":
      return (CONTENT[r] ?? GENERIC)(c);
    case "design_quality":
      return (DESIGN_QUALITY[r] ?? GENERIC)(c);
    default:
      return GENERIC(c);
  }
}

/** Rule ids with specific guidance (used by tests to keep the catalog in step with the scanners). */
export const CATALOGED_RULES: Record<string, string[]> = {
  accessibility: Object.keys(ACCESSIBILITY),
  security: Object.keys(SECURITY),
  seo: Object.keys(SEO),
  links: Object.keys(LINKS),
  performance: Object.keys(PERFORMANCE),
  responsive: Object.keys(RESPONSIVE),
  design: Object.keys(DESIGN),
  content: Object.keys(CONTENT),
  design_quality: Object.keys(DESIGN_QUALITY),
};
