/**
 * Plain-language explanations (Phase 15). Fixed, reviewed wording per scanner rule that tells a
 * non-developer what a finding means, why it matters and how to check a fix. It describes the
 * *kind* of problem only: every fact about a specific issue (pages, elements, values, counts,
 * measurements) comes from the stored findings and evidence, never from this file.
 *
 * Pure and browser-safe (used by the web app's server and client components).
 */

import type { Severity } from "./domain";

export interface RuleExplanation {
  /** What the finding means, in everyday language. */
  meaning: string;
  /** The practical effect on visitors, search engines, security or brand consistency. */
  impact: string;
  /** An optional manual check that confirms the fix before the next scan. */
  check?: string;
}

export interface IssueExplanation extends RuleExplanation {
  /** How to confirm the fix: the manual check (if any) plus a re-scan of the same pages. */
  verify: string;
  /** False when only the category's general wording is available for this rule. */
  specific: boolean;
}

type Catalog = Record<string, RuleExplanation>;

/** One entry for several rule ids that share an explanation. */
const same = (ids: string[], e: RuleExplanation): Catalog =>
  Object.fromEntries(ids.map((id) => [id, e]));

const SCREEN_READER =
  "People who use screen readers or other assistive technology may not be able to understand or use this part of the page.";

// Accessibility rules come from axe-core (rule ids as published by axe-core) plus our own
// keyboard-focus check. Unknown axe rules fall back to the category wording.
const ACCESSIBILITY: Catalog = {
  ...same(
    ["image-alt", "input-image-alt", "role-img-alt", "svg-img-alt", "area-alt", "object-alt"],
    {
      meaning:
        "An image (or image button) has no text alternative. Screen readers cannot describe what it shows.",
      impact: `${SCREEN_READER} If the image carries information or acts as a link or button, that information or action is lost for them.`,
      check:
        'Inspect each listed image: content images need a short description in alt; purely decorative images need an empty alt (alt="").',
    },
  ),
  "image-redundant-alt": {
    meaning: "The image's text alternative repeats text that is already next to it.",
    impact: "Screen-reader users hear the same words twice, which makes the page slower to follow.",
  },
  ...same(["color-contrast", "color-contrast-enhanced", "link-in-text-block"], {
    meaning:
      "Some text does not stand out enough from its background (or a link is hard to tell apart from the text around it).",
    impact:
      "People with low vision, color blindness or a screen in bright light may not be able to read it. Low contrast is one of the most common accessibility complaints.",
    check:
      "Compare the listed text and background colors with a contrast checker; the finding shows the measured ratio and the required one.",
  }),
  ...same(["link-name", "button-name", "input-button-name"], {
    meaning:
      "A link or button has no name that assistive technology can read out, for example an icon without a label.",
    impact: `${SCREEN_READER} They hear only “link” or “button” and cannot tell where it goes or what it does.`,
    check:
      "Tab to each listed control with a screen reader running and listen to what is announced.",
  }),
  ...same(
    [
      "label",
      "select-name",
      "aria-input-field-name",
      "aria-toggle-field-name",
      "label-title-only",
      "form-field-multiple-labels",
    ],
    {
      meaning: "A form field has no clear label that is connected to it.",
      impact: `${SCREEN_READER} Visitors may not know what to type or choose, so forms can be filled in wrongly or abandoned.`,
      check: "Click each field's visible label: the cursor should move into the field.",
    },
  ),
  ...same(["html-has-lang", "html-lang-valid", "valid-lang", "html-xml-lang-mismatch"], {
    meaning: "The page does not state its language correctly.",
    impact:
      "Screen readers may read the text with the wrong pronunciation, and translation tools may guess the language wrongly.",
  }),
  "document-title": {
    meaning: "The page has no title.",
    impact:
      "The browser tab, bookmarks and search results show no meaningful name, and screen-reader users do not hear which page they are on.",
  },
  "frame-title": {
    meaning: "An embedded frame (for example a video or map) has no title.",
    impact: `${SCREEN_READER} They cannot tell what the embedded content is before entering it.`,
  },
  ...same(["heading-order", "empty-heading", "page-has-heading-one", "p-as-heading"], {
    meaning:
      "The headings on the page do not form a clear outline (a level is skipped, a heading is empty, the main heading is missing, or bold text is used instead of a real heading).",
    impact:
      "Screen-reader users jump between headings to scan a page; a broken outline makes the page hard to navigate and understand.",
  }),
  ...same(
    [
      "landmark-one-main",
      "region",
      "bypass",
      "skip-link",
      "landmark-unique",
      "landmark-no-duplicate-banner",
      "landmark-no-duplicate-contentinfo",
      "landmark-no-duplicate-main",
      "landmark-complementary-is-top-level",
      "landmark-banner-is-top-level",
      "landmark-contentinfo-is-top-level",
      "landmark-main-is-top-level",
    ],
    {
      meaning:
        "The page's main areas (header, navigation, main content, footer) are not marked up so that assistive technology can find them, or there is no way to skip repeated content.",
      impact:
        "Keyboard and screen-reader users have to move through every menu link on every page before reaching the content.",
    },
  ),
  ...same(["list", "listitem", "definition-list", "dlitem"], {
    meaning: "A list is not built from proper list elements.",
    impact: `${SCREEN_READER} They are not told how many items the list has or where it ends.`,
  }),
  ...same(["duplicate-id", "duplicate-id-aria", "duplicate-id-active"], {
    meaning: "Two or more elements on the page share the same identifier (id).",
    impact:
      "Labels, error messages and other connections between elements may point to the wrong element, so assistive technology can announce the wrong information.",
  }),
  ...same(
    [
      "aria-allowed-attr",
      "aria-required-attr",
      "aria-valid-attr",
      "aria-valid-attr-value",
      "aria-roles",
      "aria-allowed-role",
      "aria-required-children",
      "aria-required-parent",
      "aria-prohibited-attr",
      "aria-deprecated-role",
      "aria-command-name",
      "aria-dialog-name",
      "aria-meter-name",
      "aria-progressbar-name",
      "aria-tooltip-name",
      "aria-treeitem-name",
      "presentation-role-conflict",
    ],
    {
      meaning:
        "Accessibility attributes (ARIA) on an element are missing, invalid or used in a way that contradicts the element.",
      impact: `${SCREEN_READER} Wrong ARIA can be worse than none, because the announced information is misleading.`,
    },
  ),
  ...same(["aria-hidden-focus", "aria-hidden-body", "frame-focusable-content"], {
    meaning:
      "Content that is hidden from assistive technology can still receive keyboard focus (or the whole page is hidden).",
    impact:
      "Keyboard and screen-reader users land on controls that are announced as nothing, and get lost on the page.",
  }),
  ...same(["nested-interactive", "scrollable-region-focusable", "tabindex", "accesskeys"], {
    meaning:
      "Keyboard use is impaired: controls are nested inside each other, a scrolling area cannot be reached with the keyboard, or the tab order or shortcut keys are set up unusually.",
    impact:
      "People who use a keyboard instead of a mouse may skip, miss or be unable to operate parts of the page.",
    check:
      "Move through the page with the Tab key and check that every control can be reached and used.",
  }),
  "focus-indicator-visible": {
    meaning:
      "When you move through the page with the Tab key, some links or buttons show no visible highlight.",
    impact:
      "Keyboard users cannot see where they are on the page, so they cannot tell which link or button they are about to use.",
    check:
      "Press Tab repeatedly on the listed page and watch that each control gets a clear outline.",
  },
  ...same(["meta-viewport", "meta-viewport-large"], {
    meaning: "The page blocks or limits zooming on mobile devices.",
    impact: "People with low vision cannot enlarge the text on their phone.",
  }),
  "meta-refresh": {
    meaning: "The page reloads or redirects itself automatically after a delay.",
    impact:
      "Visitors can lose their place or not have enough time to read, especially screen-reader users and people who read slowly.",
  },
  "target-size": {
    meaning: "Some links or buttons are very small or too close together.",
    impact:
      "People with limited dexterity, and anyone on a touch screen, may tap the wrong control or have trouble tapping the right one.",
  },
  "autocomplete-valid": {
    meaning: "A form field announces the wrong kind of personal data for browser autofill.",
    impact:
      "Autofill may fill in the wrong information, which particularly affects people with motor or memory impairments who rely on it.",
  },
  ...same(
    [
      "td-headers-attr",
      "th-has-data-cells",
      "table-duplicate-name",
      "empty-table-header",
      "scope-attr-valid",
    ],
    {
      meaning: "A data table's header cells are missing or not connected to the data cells.",
      impact: `${SCREEN_READER} They hear numbers or words without knowing which row or column they belong to.`,
    },
  ),
  ...same(["video-caption", "audio-caption"], {
    meaning: "A video or audio clip has no captions.",
    impact:
      "Deaf and hard-of-hearing visitors, and anyone watching without sound, miss what is said.",
  }),
  ...same(["blink", "marquee"], {
    meaning: "Text on the page blinks or scrolls by itself.",
    impact: "Moving text is hard to read and can distract or disturb some visitors.",
  }),
  "identical-links-same-purpose": {
    meaning: "Links with the same text lead to different places.",
    impact:
      "Visitors, especially screen-reader users scanning a list of links, cannot tell them apart.",
  },
  "server-side-image-map": {
    meaning: "The page uses a server-side image map for navigation.",
    impact: "Its links cannot be used with a keyboard or understood by screen readers.",
  },
};

const SECURITY: Catalog = {
  "https-not-used": {
    meaning: "The site is served without encryption (plain http:// instead of https://).",
    impact:
      "Anything visitors send or receive, including passwords and form data, can be read or changed by others on the same network. Browsers also mark such sites as “Not secure”.",
    check:
      "Open the site with http:// in a browser and confirm it switches to https:// with a padlock.",
  },
  "http-not-redirected": {
    meaning: "Visiting the http:// address does not send people to the secure https:// version.",
    impact:
      "Visitors who type the address without https:// or follow old links stay on the unencrypted version.",
    check: "Open the http:// address and confirm the browser ends up on the https:// address.",
  },
  "hsts-missing": {
    meaning:
      "The site does not tell browsers to always use the secure connection (the HSTS header is missing).",
    impact:
      "A visitor's first request can be intercepted and redirected by an attacker on the same network.",
  },
  "hsts-weak": {
    meaning: "The site tells browsers to use the secure connection only for a short time.",
    impact: "The protection runs out quickly, so visitors are exposed again sooner.",
  },
  "csp-missing": {
    meaning:
      "The site does not restrict which scripts and other resources a page may load (there is no Content Security Policy).",
    impact:
      "If an attacker manages to inject code into a page, nothing stops the browser from running it. A policy is a second line of defense against such attacks.",
  },
  "csp-unsafe-script": {
    meaning: "The site's Content Security Policy still allows unsafe scripts.",
    impact: "The policy gives little protection against injected code.",
  },
  "x-content-type-options-missing": {
    meaning: "The site lets browsers guess the type of downloaded files.",
    impact:
      "In some cases a browser may treat an uploaded or downloaded file as a script, which can be abused.",
  },
  "frame-protection-missing": {
    meaning: "Other websites are allowed to show these pages inside a frame.",
    impact:
      "A malicious site could overlay the page and trick visitors into clicking buttons they cannot see (clickjacking).",
  },
  "referrer-policy-unsafe": {
    meaning:
      "When visitors follow a link to another site, the full page address is shared with it.",
    impact:
      "Addresses that contain private information, such as search terms or ids, can leak to other sites.",
  },
  "referrer-policy-missing": {
    meaning:
      "The site does not state how much of its page addresses may be shared with other sites.",
    impact: "Browsers then use their default, which may share more than intended.",
  },
  "permissions-policy-missing": {
    meaning:
      "The site does not switch off browser features it does not use (such as camera, microphone or location).",
    impact:
      "If third-party or injected code runs on the page, it could ask visitors for access to these features.",
  },
  "server-version-disclosure": {
    meaning: "The server announces which software and version it runs.",
    impact:
      "This helps attackers look up known weaknesses of that exact version. It is not a vulnerability on its own.",
  },
  "cookie-flags": {
    meaning: "Some cookies are missing standard protection settings.",
    impact:
      "Cookies, including login sessions, may be sent over unencrypted connections, read by scripts or sent along with requests from other sites.",
  },
  "insecure-form-action": {
    meaning: "A form sends what visitors type over an unencrypted connection.",
    impact:
      "The submitted data, possibly including personal details or passwords, can be read in transit.",
  },
  "sri-missing": {
    meaning:
      "Scripts or styles are loaded from another company's server without a check that they have not been changed.",
    impact:
      "If that server is compromised, the altered file would run on this site for every visitor.",
  },
};

const EXPOSED_SECRET: RuleExplanation = {
  meaning:
    "Something that looks like a secret key or access token is visible in the page source. Anyone visiting the page can see it.",
  impact:
    "If it is a real credential, others could use it to access the connected service, run up costs or read data. The scanner masks the value; only the owner can confirm whether it is real.",
  check:
    "Confirm with the owner of the service whether the key is real. A rotated (replaced) key no longer works even if it was copied.",
};

const SEO: Catalog = {
  "title-missing": {
    meaning: "The page has no title.",
    impact:
      "Search engines show the title as the clickable headline in results; without one they make one up, and the browser tab shows no name.",
  },
  "title-length": {
    meaning: "The page title is too short or too long.",
    impact:
      "Search engines may cut it off or rewrite it, so the headline in search results is less useful.",
  },
  "meta-description-missing": {
    meaning: "The page has no summary (meta description) for search engines.",
    impact:
      "Search results show a random excerpt of the page instead of a written summary, which may get fewer clicks.",
  },
  "meta-description-length": {
    meaning: "The page summary for search engines is too short or too long.",
    impact: "Search engines may cut it off or replace it with an excerpt of the page.",
  },
  "h1-missing": {
    meaning: "The page has no main heading.",
    impact:
      "Search engines and screen-reader users rely on the main heading to understand what the page is about.",
  },
  "h1-multiple": {
    meaning: "The page has more than one main heading.",
    impact:
      "It is less clear to search engines and screen-reader users what the page's main topic is.",
  },
  "heading-level-skipped": {
    meaning:
      "The headings skip a level (for example a main heading followed directly by a third-level heading).",
    impact: "The page outline is harder to follow for search engines and screen-reader users.",
  },
  noindex: {
    meaning: "The page tells search engines not to list it.",
    impact:
      "The page will not appear in search results. This is correct for private or duplicate pages, but a mistake on pages that should be found.",
  },
  "canonical-multiple": {
    meaning: "The page declares more than one preferred address (canonical URL).",
    impact:
      "Search engines may ignore the declaration, so duplicate versions of the page can compete with each other.",
  },
  "canonical-missing": {
    meaning: "The page does not declare its preferred address (canonical URL).",
    impact:
      "If the same content is reachable under several addresses, search engines may split its ranking between them.",
  },
  "html-lang-missing": {
    meaning: "The page does not state its language.",
    impact: "Search engines and screen readers may treat the text as the wrong language.",
  },
  "viewport-meta-missing": {
    meaning: "The page is not set up for mobile screens.",
    impact:
      "Phones show a shrunken desktop page, and search engines may rank it lower for mobile searches.",
  },
  "img-alt-attribute-missing": {
    meaning: "Some images have no text alternative.",
    impact:
      "Search engines use the alternative text to understand images (for image search), and screen-reader users cannot tell what the images show.",
  },
  "structured-data-invalid": {
    meaning:
      "The page's structured data (machine-readable information for search engines) contains errors.",
    impact:
      "Search engines cannot read it, so rich results such as ratings, prices or event dates are not shown.",
  },
  "structured-data-absent": {
    meaning: "The site has no structured data (machine-readable information for search engines).",
    impact:
      "Search results cannot show extra details such as ratings, prices or the company logo. This is an opportunity, not an error.",
  },
  "title-duplicate": {
    meaning: "Several pages share the same title.",
    impact:
      "Searchers cannot tell the pages apart in results, and search engines may treat them as duplicates.",
  },
  "meta-description-duplicate": {
    meaning: "Several pages share the same summary for search engines.",
    impact: "Search results look the same for different pages, which makes them less useful.",
  },
  "open-graph-missing": {
    meaning: "The page has no preview information for social media and messaging apps.",
    impact:
      "Links shared on social media or in chats appear without a proper title, description or image.",
  },
  "url-structure": {
    meaning: "Some page addresses are long, contain unusual characters or are hard to read.",
    impact:
      "Readable addresses are easier to share and give searchers a hint of what the page contains.",
  },
  "robots-txt-missing": {
    meaning:
      "The site has no robots.txt file (the file that tells search engines what they may crawl).",
    impact: "Search engines crawl everything they find and may not discover the sitemap.",
  },
  "sitemap-not-found": {
    meaning: "The sitemap that the site points to cannot be found.",
    impact: "Search engines cannot use it to discover the site's pages.",
  },
  "sitemap-invalid": {
    meaning: "The sitemap file is broken.",
    impact: "Search engines cannot read it, so new or deep pages may be found late or not at all.",
  },
  "sitemap-missing": {
    meaning: "The site has no sitemap (a list of its pages for search engines).",
    impact: "Search engines may find new or rarely linked pages late or not at all.",
  },
};

const LINKS: Catalog = {
  "broken-internal-link": {
    meaning:
      "A link on the site leads to one of the site's own pages that does not exist or returns an error.",
    impact:
      "Visitors hit an error page and may leave; search engines see a poorly maintained site.",
    check: "Click the listed links on the listed pages and confirm they open the intended page.",
  },
  "broken-external-link": {
    meaning: "A link to another website no longer works.",
    impact: "Visitors who follow it reach an error page, which reflects poorly on the site.",
    check: "Click the listed links and confirm they open a working page.",
  },
  "link-temporarily-unavailable": {
    meaning: "A link could not be reached during the scan, but the failure may be temporary.",
    impact:
      "If the problem persists, visitors will hit an error. One failed check alone does not prove the link is broken.",
  },
  "redirect-chain": {
    meaning: "A link passes through several redirects before reaching its final page.",
    impact: "Each redirect adds waiting time for visitors and can dilute search ranking.",
  },
  "internal-link-redirects": {
    meaning: "Links within the site point to an old address that redirects elsewhere.",
    impact: "Visitors wait a little longer, and search engines spend crawl time on redirects.",
  },
  "failed-resource": {
    meaning: "A file the page needs (such as an image, script or stylesheet) failed to load.",
    impact: "Parts of the page may be missing, unstyled or not working.",
  },
  "mixed-content-active": {
    meaning: "A secure (https) page loads scripts or styles over an insecure (http) connection.",
    impact:
      "Browsers block these files, so parts of the page can break; if not blocked, an attacker could change them.",
  },
  "mixed-content-passive": {
    meaning: "A secure (https) page loads images or media over an insecure (http) connection.",
    impact: "Browsers may show a security warning or block the content.",
  },
};

const PERFORMANCE: Catalog = {
  "lcp-slow": {
    meaning:
      "The main content of the page (usually the biggest image or heading) takes long to appear.",
    impact:
      "Visitors stare at an incomplete page and may leave. Search engines use this measurement in rankings.",
  },
  "cls-slow": {
    meaning: "Parts of the page jump around while it loads.",
    impact:
      "Visitors lose their place or click the wrong thing when content moves under their finger or mouse.",
  },
  "tbt-slow": {
    meaning:
      "The page is busy running code while it loads and cannot respond to clicks and typing.",
    impact: "Buttons and menus feel frozen or slow to react.",
  },
  "ttfb-slow": {
    meaning: "The server takes long to start sending the page.",
    impact: "Everything else is delayed by the same amount, so the whole page feels slow.",
  },
  "fcp-slow": {
    meaning: "It takes long before anything at all appears on the screen.",
    impact: "Visitors see a blank page and may think the site is broken.",
  },
  "page-weight": {
    meaning: "The page downloads a lot of data.",
    impact: "It loads slowly on mobile networks and uses up visitors' data plans.",
  },
  "javascript-size": {
    meaning: "The page downloads a lot of JavaScript code.",
    impact:
      "Code takes time to download and run, which slows the page down, especially on older phones.",
  },
  "css-size": {
    meaning: "The page downloads a lot of styling code (CSS).",
    impact: "The page cannot be shown until its styles are loaded, so large style files delay it.",
  },
  "request-count": {
    meaning: "The page needs a very large number of separate files.",
    impact: "Each file is a separate request, which adds up to a slower page.",
  },
  "image-oversized": {
    meaning: "Images are much larger than the size they are shown at.",
    impact: "Visitors download extra data they never see, which slows the page.",
  },
  "image-large": {
    meaning: "Some image files are very large.",
    impact: "They slow the page down, particularly on mobile connections.",
  },
  "render-blocking-resource": {
    meaning: "Files in the page's header must be fully loaded before anything is shown.",
    impact: "The page stays blank longer than necessary.",
  },
};

const RESPONSIVE: Catalog = {
  "horizontal-overflow": {
    meaning:
      "At this screen size the page is wider than the screen, so it can be scrolled sideways.",
    impact:
      "Content is cut off at the edge and the page wobbles when visitors scroll, which feels broken on phones.",
    check:
      "Open the listed page at the listed screen size and check that it cannot be scrolled sideways.",
  },
  "text-clipped": {
    meaning: "Some text is cut off because its box is too small.",
    impact: "Visitors cannot read the full text, which can hide important information.",
  },
  "interactive-overlap": {
    meaning: "Links or buttons overlap each other at this screen size.",
    impact: "Visitors may tap the wrong control or be unable to reach one of them.",
  },
  "tap-target-small": {
    meaning: "Some links or buttons are too small to tap comfortably on a touch screen.",
    impact: "Visitors miss them or tap the wrong one, especially people with limited dexterity.",
  },
  "text-too-small-mobile": {
    meaning: "Some text is very small on mobile screens.",
    impact: "Visitors have to zoom in to read it, and some cannot read it at all.",
  },
  "image-not-rendered": {
    meaning: "An image failed to display.",
    impact: "Visitors see an empty space or a broken-image icon instead of the intended picture.",
  },
  "mobile-nav-unreachable": {
    meaning: "On small screens the site's navigation menu cannot be reached.",
    impact: "Mobile visitors cannot move between the site's main sections.",
  },
  "mobile-menu-broken": {
    meaning: "The mobile menu button does not open the navigation.",
    impact: "Mobile visitors cannot get to other pages from the menu.",
    check: "On a phone-sized screen, tap the menu button and confirm the links appear.",
  },
};

const DESIGN_MISMATCH = (what: string): RuleExplanation => ({
  meaning: `The ${what} on the website differs from the value in the confirmed design reference.`,
  impact:
    "The site looks different from the approved design, which weakens brand consistency. Small differences can also be intentional; the design reference decides.",
});

const DESIGN: Catalog = {
  "design-color-mismatch": DESIGN_MISMATCH("color"),
  "design-color-near-palette": {
    meaning:
      "A color on the website is very close to a brand color but not exactly the same, which often indicates a typo or an old value.",
    impact: "Slightly different shades make the brand look inconsistent across pages.",
  },
  "design-font-family-mismatch": DESIGN_MISMATCH("typeface (font family)"),
  "design-font-size-mismatch": DESIGN_MISMATCH("text size"),
  "design-font-weight-mismatch": DESIGN_MISMATCH("text weight (boldness)"),
  "design-line-height-mismatch": DESIGN_MISMATCH("line spacing"),
  "design-letter-spacing-mismatch": DESIGN_MISMATCH("letter spacing"),
  "design-radius-mismatch": DESIGN_MISMATCH("corner rounding"),
  "design-spacing-mismatch": DESIGN_MISMATCH("spacing (padding)"),
  "design-width-mismatch": DESIGN_MISMATCH("width"),
};

const CONTENT: Catalog = {
  "content-missing": {
    meaning:
      "Text from the approved content document could not be found on the page it belongs to.",
    impact:
      "Visitors may be missing approved information, or the page may still show an older version of the content.",
  },
  "content-changed-wording": {
    meaning: "The page has text similar to the approved content, but the wording has been changed.",
    impact:
      "Visitors read wording that was not approved, which can matter for legal, product or brand statements.",
  },
  "content-different-wording": {
    meaning: "The page's text only partly matches the approved content.",
    impact:
      "The difference may be intentional or a mistake; someone who knows the content should review it.",
  },
  "content-capitalization": {
    meaning: "The page's text matches the approved content except for capital letters.",
    impact: "A minor inconsistency, but it matters for product names, headings and brand terms.",
  },
  "content-link-target-mismatch": {
    meaning: "A link's text matches the approved content, but it points to a different address.",
    impact: "Visitors who click it end up somewhere other than intended.",
  },
  "content-cta-not-link": {
    meaning:
      "A call to action from the approved content (such as “Book a demo”) appears as plain text instead of a link or button.",
    impact: "Visitors cannot click it, so the action it promotes is lost.",
  },
};

const DESIGN_QUALITY: Catalog = {
  "dq-heading-inconsistent": {
    meaning:
      "Headings of the same level (for example all H2 headings) are shown in different fonts, sizes, weights or styles at the same screen size.",
    impact:
      "Inconsistent headings make pages look unpolished and make it harder for visitors to see how content is organised. A different style can be intentional (for example a hero heading), so review it.",
    check:
      "Open the listed pages side by side at the listed screen size and compare the headings of that level.",
  },
  "dq-heading-hierarchy-inverted": {
    meaning:
      "A lower-level heading (for example H3) is drawn larger than a higher-level heading (for example H2) on the same page.",
    impact:
      "Visitors read size as importance, so the page's visual outline contradicts its real structure. This is a visual check; the heading order for screen readers is checked by the accessibility scanner.",
  },
  "dq-webfont-not-rendered": {
    meaning:
      "The site asks for a web font, but the browser drew the text with a different (fallback) font.",
    impact:
      "Visitors see the wrong typeface, which breaks the brand look and can change text width and line breaks.",
    check:
      "Open the page with the browser's developer tools, select the listed text and look at “Rendered fonts” in the Computed tab; check the Network tab for failed font files.",
  },
  "dq-font-not-approved": {
    meaning:
      "Headings or body text use a font that is not among the font files uploaded to this project as brand fonts.",
    impact:
      "Text set in a non-brand font weakens brand consistency. Other fonts may be allowed for some text, so review it.",
  },
  "dq-image-upscaled": {
    meaning:
      "An image is displayed larger than the resolution of its source file, so the browser has to enlarge it.",
    impact: "Enlarged images look soft or pixelated, especially on high-density (retina) screens.",
    check:
      "Open the image address directly and compare its pixel size with the size it is displayed at on the page.",
  },
  "dq-image-distorted": {
    meaning:
      "An image is stretched or squashed because it is drawn into a box with a different shape than the image.",
    impact: "Distorted photos, logos and product images look broken and unprofessional.",
  },
  "dq-spacing-off-scale": {
    meaning:
      "Some margins, paddings or gaps use values that are not on the spacing scale of the confirmed design reference.",
    impact:
      "Spacing outside the agreed scale makes layouts look uneven across pages. Some values can be intentional, so review them.",
  },
  "dq-alignment-near-miss": {
    meaning:
      "Two elements stacked on top of each other start a few pixels apart horizontally, which looks like an alignment mistake.",
    impact:
      "Small misalignments make a page look unfinished. A deliberate indent is usually larger, so review it.",
  },
  "dq-spacing-inconsistent": {
    meaning: "Repeated items of the same kind (cards, list items, buttons) are not evenly spaced.",
    impact: "Uneven gaps make a layout look unbalanced. Review whether the difference is intended.",
  },
};

/** General wording per category, for rules without a specific entry. */
const CATEGORY_DEFAULTS: Record<string, RuleExplanation> = {
  accessibility: {
    meaning:
      "Part of the page does not meet an accessibility rule. The scanner's message below names the exact requirement.",
    impact:
      "People who use screen readers, keyboards, magnification or other assistive technology may find this part of the page hard or impossible to use.",
  },
  security: {
    meaning:
      "The scanner found a security setting or practice that does not follow common recommendations.",
    impact:
      "Weak security settings make it easier to attack the site or its visitors. The finding below explains what was observed.",
  },
  seo: {
    meaning:
      "The scanner found something that makes the page harder for search engines to understand or show.",
    impact: "The page may appear lower in search results or with a less useful listing.",
  },
  links: {
    meaning: "A link or a file the page uses did not work as expected.",
    impact: "Visitors may reach error pages or see pages with missing parts.",
  },
  performance: {
    meaning:
      "The page was slower or heavier than the recommended limit in the scanner's lab measurement.",
    impact:
      "Slow pages frustrate visitors, cause people to leave and can rank lower in search results.",
  },
  responsive: {
    meaning: "The page's layout has a problem at one or more screen sizes.",
    impact: "Visitors on that kind of device may see a broken or hard-to-use page.",
  },
  design: {
    meaning: "The website differs from the confirmed design reference.",
    impact: "The site looks different from the approved design, which weakens brand consistency.",
  },
  content: {
    meaning: "The website's text differs from the approved content documents.",
    impact: "Visitors may read wording that was not approved.",
  },
  design_quality: {
    meaning:
      "The scanner measured a typography, image or layout quality problem in the rendered page.",
    impact: "The page looks less consistent or polished than intended.",
  },
};

const GENERAL_DEFAULT: RuleExplanation = {
  meaning: "The scanner reported a problem. The findings below describe exactly what was observed.",
  impact: "Review the evidence to judge the effect on visitors.",
};

/** What a re-scan must do to confirm a fix, per category. */
const RESCAN: Record<string, string> = {
  design:
    "Run a new scan with the same confirmed design reference. The scan comparison shows the issue as Resolved only if the same pages and screen sizes were checked again and it was not found.",
  content:
    "Run a new scan with the same approved content documents. The scan comparison shows the issue as Resolved only if the same pages were checked again and it was not found.",
  performance:
    "Run a new scan. Lab measurements vary from run to run, so compare more than one scan before treating a borderline result as fixed.",
  design_quality:
    "Run a new scan with Design Quality & Typography enabled. The scan comparison shows the issue as Resolved only if the same pages and screen sizes were checked again and it was not found.",
};
const RESCAN_DEFAULT =
  "Run a new scan of the same pages. The scan comparison shows the issue as Resolved only if the scanner checked those pages again and did not find it.";

/** The re-scan step that confirms a fix for an issue of this category. */
export function rescanAdvice(category: string): string {
  return RESCAN[category] ?? RESCAN_DEFAULT;
}

const CATALOGS: Record<string, Catalog> = {
  accessibility: ACCESSIBILITY,
  security: SECURITY,
  seo: SEO,
  links: LINKS,
  performance: PERFORMANCE,
  responsive: RESPONSIVE,
  design: DESIGN,
  content: CONTENT,
  design_quality: DESIGN_QUALITY,
};

function lookup(category: string, ruleId: string | null): RuleExplanation | undefined {
  if (!ruleId) return undefined;
  if (category === "security" && ruleId.startsWith("exposed-secret-")) return EXPOSED_SECRET;
  const catalog = CATALOGS[category];
  return catalog && Object.hasOwn(catalog, ruleId) ? catalog[ruleId] : undefined;
}

/** Plain-language explanation of an issue's rule (category wording when the rule is unknown). */
export function explainIssue(category: string, ruleId: string | null): IssueExplanation {
  const specific = lookup(category, ruleId);
  const e = specific ?? CATEGORY_DEFAULTS[category] ?? GENERAL_DEFAULT;
  const rescan = RESCAN[category] ?? RESCAN_DEFAULT;
  return {
    ...e,
    verify: e.check ? `${e.check} Then ${rescan[0]!.toLowerCase()}${rescan.slice(1)}` : rescan,
    specific: Boolean(specific),
  };
}

/** Rule ids with a specific explanation (used by tests to keep the wording in step with the scanners). */
export const EXPLAINED_RULES: Record<string, string[]> = Object.fromEntries(
  Object.entries(CATALOGS).map(([k, v]) => [k, Object.keys(v)]),
);

/** What each severity level means for the person deciding what to fix first. */
export const SEVERITY_MEANINGS: Record<Severity, string> = {
  critical:
    "Critical: can block visitors from using the site or expose it to serious risk. Fix first.",
  high: "High: likely to cause real problems for many visitors or for security. Fix soon.",
  medium: "Medium: causes problems for some visitors or in some situations. Plan a fix.",
  low: "Low: a minor problem or an improvement with limited effect.",
  info: "Informational: worth knowing; not necessarily a problem.",
};

/** Plain-language meaning of each finding verdict stored by the scanners. */
export const VERDICT_MEANINGS: Record<string, { label: string; meaning: string }> = {
  confirmed: {
    label: "Confirmed",
    meaning: "The scanner observed this problem directly on the page.",
  },
  potential: {
    label: "Needs review",
    meaning:
      "The scanner saw signs of a problem but could not confirm it automatically. A person should check it before acting.",
  },
  inconclusive: {
    label: "Unable to verify",
    meaning:
      "The scanner could not check this reliably (for example the page did not load fully). It may or may not be a real problem.",
  },
  unable_to_verify: {
    label: "Unable to verify",
    meaning: "The available evidence is not enough to confirm or rule out this problem.",
  },
};

/** How the stored confidence value is produced (scanner-assigned per detection method). */
export const CONFIDENCE_EXPLANATION =
  "Confidence is set by the scanner for its detection method: high when the problem was measured directly, lower when it was inferred. It is not a statistical probability.";

/** One line per finding source: what it checks, for people choosing scanners. */
export const SOURCE_DESCRIPTIONS: Record<string, string> = {
  accessibility:
    "Problems for people using screen readers, keyboards or magnification (axe-core rules, contrast, labels, keyboard focus).",
  security:
    "Passive checks of HTTPS, security headers, cookies, forms and exposed keys. No attacks are attempted.",
  seo: "Titles, descriptions, headings, indexing, canonical links, sitemaps and structured data.",
  links: "Broken links, redirects, missing files and insecure (http) content on https pages.",
  performance:
    "Lab measurements of loading speed, layout shifts and page weight in a test browser.",
  responsive:
    "Layout problems at desktop, tablet and phone sizes: sideways scrolling, clipped text, small tap targets, menus.",
  design: "Colors, fonts and spacing compared with the confirmed design reference.",
  content: "Website text compared with the uploaded approved content documents.",
  design_quality:
    "Checks heading typography, font sizes, spacing, alignment, image clarity, and approved-content consistency against the available project references.",
};
