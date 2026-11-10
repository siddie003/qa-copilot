import { describe, expect, it } from "vitest";
import {
  attrOf,
  buildIssueGuide,
  contrastRatio,
  contrastSafeColor,
  GUIDED_RULES,
  withAttribute,
  type GuideFinding,
  type GuideIssue,
} from "./fix-guide";

const PAGE = "https://shop.example.test/";

const finding = (over: Partial<GuideFinding> = {}): GuideFinding => ({
  displayId: "F-001",
  selector: null,
  viewport: null,
  pageUrl: PAGE,
  expected: null,
  actual: null,
  evidence: [],
  ...over,
});

const issue = (over: Partial<GuideIssue> = {}): GuideIssue => ({
  category: "accessibility",
  ruleId: "image-alt",
  verdict: "confirmed",
  affectedUrls: [PAGE],
  affectedElement: null,
  recommendation: null,
  findings: [finding()],
  ...over,
});

const NAV_ICON =
  '<img loading="lazy" decoding="async" src="https://shop.example.test/image.svg" class="nav__icon-mobile">';

/** Every URL in the guide must come from the input (or be an obvious placeholder). */
function inventedUrls(input: GuideIssue): string[] {
  const out = JSON.stringify(buildIssueGuide(input));
  const known = JSON.stringify(input);
  return (
    [...out.matchAll(/https?:\/\/[^\s"'<>`)\]\\]+/g)]
      .map((m) => m[0].replace(/[.,;]+$/, ""))
      // https://schema.org is the JSON-LD vocabulary id (fixed syntax), not an address of the site.
      .filter((u) => !u.startsWith("https://…") && u !== "https://schema.org" && !known.includes(u))
  );
}

describe("HTML helpers", () => {
  it("sets or replaces an attribute on the first matching start tag only", () => {
    expect(withAttribute('<img src="a.svg">', "alt", "")).toBe('<img src="a.svg" alt="">');
    expect(withAttribute('<img src="a.svg"/>', "alt", "x")).toBe('<img src="a.svg" alt="x" />');
    expect(withAttribute('<img alt="old" src="a">', "alt", "new")).toBe('<img alt="new" src="a">');
    expect(withAttribute('<div><a href="/x">Go</a></div>', "href", "/y", "a")).toBe(
      '<div><a href="/y">Go</a></div>',
    );
    // A truncated tag (no closing >) is never "completed" by guessing.
    expect(withAttribute('<img src="https://example.test/very-long…', "alt", "")).toBeNull();
    expect(attrOf(NAV_ICON, "class")).toBe("nav__icon-mobile");
    expect(attrOf(NAV_ICON, "alt")).toBeNull();
  });

  it("calculates WCAG contrast and the nearest passing shade", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    const safe = contrastSafeColor("#999999", "#ffffff", 4.5)!;
    expect(contrastRatio(safe, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Light text on a dark background moves toward white.
    const light = contrastSafeColor("#555555", "#000000", 4.5)!;
    expect(contrastRatio(light, "#000000")).toBeGreaterThanOrEqual(4.5);
    expect(contrastSafeColor("#80808080", "#ffffff", 4.5)).toBeNull(); // translucent: not guessed
  });
});

describe("accessibility guides", () => {
  const navIcon = issue({
    affectedElement: ".nav__icon-mobile",
    findings: [
      finding({
        displayId: "A11Y-024",
        selector: ".nav__icon-mobile",
        viewport: "mobile",
        evidence: [
          {
            kind: "axe_node",
            data: {
              ruleId: "image-alt",
              impact: "critical",
              wcag: ["wcag2a", "wcag111"],
              helpUrl: "https://dequeuniversity.com/rules/axe/4.13/image-alt",
              html: NAV_ICON,
              failureSummary:
                "Fix any of the following:\n  Element does not have an alt attribute\n  aria-label attribute does not exist or is empty",
            },
          },
        ],
      }),
    ],
  });

  it("explains a missing alt from the recorded element without guessing what the image shows", () => {
    const g = buildIssueGuide(navIcon);
    expect(g.specific).toBe(true);
    expect(g.problem).toMatch(/has no text alternative/);
    expect(g.problem).toContain("nav__icon-mobile");
    expect(g.problem).toMatch(/suggests an icon, logo or navigation control/);
    expect(g.snippet).toEqual({ html: NAV_ICON, findingId: "A11Y-024" });
    const [informative, decorative, control] = g.examples;
    expect(informative!.before).toBe(NAV_ICON);
    expect(informative!.beforeOrigin).toBe("observed");
    expect(informative!.after).toContain('alt="[describe what the image shows or does]"');
    expect(decorative!.after).toContain('alt=""');
    expect(control!.title).toMatch(/only content of a link or button/);
    expect(g.gaps.join(" ")).toMatch(/cannot see what the image shows/);
    expect(g.facts).toContainEqual({ label: "WCAG success criterion", value: "1.1.1" });
    expect(g.facts).toContainEqual({ label: "axe-core impact", value: "critical" });
    expect(g.steps[0]).toMatch(/Open https:\/\/shop\.example\.test\/ at the mobile screen size/);
    expect(g.steps.join(" ")).toContain("https://dequeuniversity.com/rules/axe/4.13/image-alt");
    // No invented purpose for the image.
    expect(JSON.stringify([g.problem, g.nextAction, g.examples])).not.toMatch(
      /chart|sales|divider|photo/i,
    );
    expect(inventedUrls(navIcon)).toEqual([]);
  });

  it("verifies through a new scan and never presents the fix as done", () => {
    const g = buildIssueGuide(navIcon);
    expect(g.verify.join(" ")).toMatch(/Run a new scan of the same pages/);
    expect(g.verify.join(" ")).toMatch(/include the same screen sizes \(mobile\)/);
    expect(g.verify.join(" ")).toMatch(/Marking it Resolved yourself does not verify the fix/);
    expect(g.verify.join(" ")).toContain("(shop.example.test)");
    expect(JSON.stringify(g)).not.toMatch(/\b(is|has been) (fixed|resolved)\b/i);
  });

  it("detects the platform only from recorded URLs", () => {
    const wp = buildIssueGuide(
      issue({
        findings: [
          finding({
            evidence: [
              { kind: "axe_node", data: { html: '<img src="/wp-content/uploads/a.jpg">' } },
            ],
          }),
        ],
      }),
    );
    expect(wp.steps.join(" ")).toMatch(/WordPress: set the “Alternative Text” field/);
    const next = buildIssueGuide(
      issue({
        findings: [
          finding({
            evidence: [
              { kind: "axe_node", data: { html: '<img src="/_next/image?url=%2Fa.png&w=64">' } },
            ],
          }),
        ],
      }),
    );
    expect(next.examples.map((e) => e.language)).toContain("jsx");
    expect(JSON.stringify(buildIssueGuide(navIcon))).not.toMatch(/WordPress|Shopify|Next\.js/);
  });

  it("reads the measured contrast and suggests a calculated, labelled color", () => {
    const g = buildIssueGuide(
      issue({
        ruleId: "color-contrast",
        affectedElement: "p.muted",
        findings: [
          finding({
            selector: "p.muted",
            evidence: [
              {
                kind: "axe_node",
                data: {
                  failureSummary:
                    "Fix any of the following:\n  Element has insufficient color contrast of 2.85 (foreground color: #999999, background color: #ffffff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(g.facts).toContainEqual({ label: "Measured contrast", value: "2.85:1" });
    expect(g.facts).toContainEqual({ label: "Text color", value: "#999999", code: true });
    const ex = g.examples[0]!;
    expect(ex.before).toContain("color: #999999;");
    const suggested = /color: (#[0-9a-f]{6}); \/\* ([\d.]+):1 on #ffffff \(calculated\)/.exec(
      ex.after,
    )!;
    expect(contrastRatio(suggested[1]!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(g.gaps).toEqual([]);
  });

  it("falls back honestly when contrast details cannot be read", () => {
    const g = buildIssueGuide(issue({ ruleId: "color-contrast" }));
    expect(g.examples).toEqual([]);
    expect(g.gaps.join(" ")).toMatch(/could not be read from the evidence/);
  });

  it("names icon-only buttons and links with an aria-label placeholder on the control", () => {
    const html = '<button class="close"><svg viewBox="0 0 10 10"></svg></button>';
    const g = buildIssueGuide(
      issue({
        ruleId: "button-name",
        findings: [finding({ evidence: [{ kind: "axe_node", data: { html } }] })],
      }),
    );
    expect(g.examples[0]!.after).toBe(
      '<button class="close" aria-label="[what the button does]"><svg viewBox="0 0 10 10"></svg></button>',
    );
    expect(g.steps.join(" ")).toMatch(/aria-hidden="true"/);
    const link = buildIssueGuide(
      issue({
        ruleId: "link-name",
        findings: [
          finding({
            evidence: [{ kind: "axe_node", data: { html: '<a href="/cart"><i></i></a>' } }],
          }),
        ],
      }),
    );
    expect(link.examples[0]!.after).toBe(
      '<a href="/cart" aria-label="[what the link does]"><i></i></a>',
    );
  });

  it("uses the stored guidance for accessibility rules without a specific guide", () => {
    const g = buildIssueGuide(
      issue({
        ruleId: "aria-valid-attr",
        recommendation:
          "Fix each listed element so it passes the axe-core rule “aria-valid-attr”. Re-test the page with the keyboard.",
      }),
    );
    expect(g.specific).toBe(false);
    expect(g.steps).toContain("Re-test the page with the keyboard.");
    expect(g.gaps.join(" ")).toMatch(/no rule-specific guide/);
  });
});

describe("security guides", () => {
  const header = (data: Record<string, unknown>) =>
    finding({ evidence: [{ kind: "header", data }] });

  it("explains a missing header as a missing protection, not an attack", () => {
    const g = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "hsts-missing",
        findings: [
          header({
            affectedPages: 3,
            pagesChecked: 4,
            observations: [{ url: PAGE, header: "strict-transport-security", value: null }],
          }),
        ],
      }),
    );
    expect(g.facts).toContainEqual({
      label: "Strict-Transport-Security in the scanned response",
      value: "not sent",
      code: false,
    });
    expect(g.facts).toContainEqual({ label: "Pages affected", value: "3 of 4 checked" });
    expect(g.examples[0]!.before).toBeNull();
    expect(g.examples[0]!.after).toMatch(/^Strict-Transport-Security: max-age=/);
    expect(g.caveats.join(" ")).toMatch(/not evidence that the site has been attacked/);
  });

  it("never reports a header as missing when the evidence did not record it", () => {
    const g = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "csp-unsafe-script",
        findings: [
          {
            ...header({
              observations: [
                {
                  url: PAGE,
                  directive: "script-src",
                  sources: ["'self'", "'unsafe-inline'"],
                  problems: ["'unsafe-inline'"],
                },
              ],
            }),
            actual: "script-src 'self' 'unsafe-inline'",
          },
        ],
      }),
    );
    expect(JSON.stringify(g.facts)).not.toMatch(/not sent/);
    expect(g.facts).toContainEqual({ label: "Unsafe script sources", value: "'unsafe-inline'" });
    expect(g.examples[0]!.before).toContain("script-src 'self' 'unsafe-inline'");
    expect(g.examples[0]!.beforeOrigin).toBe("observed");
  });

  it("uses X-Frame-Options evidence for framing and masks cookie values", () => {
    const frame = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "frame-protection-missing",
        findings: [header({ observations: [{ url: PAGE, "x-frame-options": "ALLOW-FROM x" }] })],
      }),
    );
    expect(frame.examples[0]!.before).toBe("X-Frame-Options: ALLOW-FROM x");
    expect(frame.examples[1]!.after).toBe("Content-Security-Policy: frame-ancestors 'self'");

    const cookie = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "cookie-flags",
        findings: [
          header({
            header: "set-cookie",
            value: "session=s3cr3t-value; Path=/",
            missing: ["Secure", "SameSite"],
          }),
        ],
      }),
    );
    expect(cookie.examples[0]!.after).toBe(
      "Set-Cookie: session=[value]; Path=/; Secure; SameSite=Lax",
    );
    expect(JSON.stringify(cookie)).not.toContain("s3cr3t-value");
  });

  it("treats exposed secrets as unconfirmed and puts revocation first", () => {
    const g = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "exposed-secret-github-token",
        verdict: "potential",
        findings: [
          finding({
            evidence: [{ kind: "html_snippet", data: { match: "ghp_…abcd", context: "x[MATCH]" } }],
          }),
        ],
      }),
    );
    expect(g.specific).toBe(true);
    expect(g.nextAction).toMatch(/^First check whether the problem is real/);
    expect(g.gaps.join(" ")).toMatch(/cannot tell whether the key is real/);
    expect(g.steps.join(" ")).toMatch(/revoke \(rotate\) it/);
  });
});

describe("SEO, links, performance, responsive, design and content guides", () => {
  it("SEO: shows the recorded page values and clearly placeholder snippets", () => {
    const g = buildIssueGuide(
      issue({
        category: "seo",
        ruleId: "meta-description-missing",
        findings: [
          finding({ evidence: [{ kind: "document", data: { url: PAGE, description: null } }] }),
        ],
      }),
    );
    expect(g.facts).toContainEqual({ label: "Current description", value: "none" });
    expect(g.examples[0]!.after).toContain('content="[One or two sentences about this page]"');
    const canonical = buildIssueGuide(issue({ category: "seo", ruleId: "canonical-missing" }));
    expect(canonical.examples[0]!.after).toContain(`href="${PAGE}"`);
    expect(canonical.examples[0]!.explanation).toMatch(/uses the scanned address/);
  });

  it("links: reports the verified result and suggests a placeholder target", () => {
    const anchor = '<a href="/old-page">Pricing</a>';
    const g = buildIssueGuide(
      issue({
        category: "links",
        ruleId: "broken-internal-link",
        findings: [
          finding({
            evidence: [
              {
                kind: "link_check",
                data: {
                  target: "https://shop.example.test/old-page",
                  status: 404,
                  attempts: 1,
                  error: null,
                  linkedFrom: [{ page: PAGE, linkText: "Pricing", html: anchor }],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(g.problem).toBe(
      "A link on https://shop.example.test/ points to https://shop.example.test/old-page that answered HTTP 404 when the scanner checked it.",
    );
    expect(g.facts).toContainEqual({ label: "Result", value: "HTTP 404 · after 1 attempt" });
    expect(g.examples[0]).toMatchObject({
      before: anchor,
      after: '<a href="[working address]">Pricing</a>',
    });
    const blocked = buildIssueGuide(
      issue({
        category: "links",
        ruleId: "broken-external-link",
        findings: [
          finding({
            evidence: [{ kind: "link_check", data: { target: "https://x.test/", status: 403 } }],
          }),
        ],
      }),
    );
    expect(blocked.caveats.join(" ")).toMatch(
      /HTTP 403 often means the other site refuses automated checks/,
    );
  });

  it("links: a temporary failure is not called broken; redirects use both recorded addresses", () => {
    const t = buildIssueGuide(issue({ category: "links", ruleId: "link-temporarily-unavailable" }));
    expect(t.gaps.join(" ")).toMatch(/reports this as temporary rather than broken/);
    const r = buildIssueGuide(
      issue({
        category: "links",
        ruleId: "redirect-chain",
        findings: [
          finding({
            evidence: [
              {
                kind: "link_check",
                data: {
                  target: "http://shop.example.test/a",
                  finalUrl: "https://shop.example.test/c",
                  redirectChain: [
                    { url: "http://shop.example.test/a", status: 301 },
                    { url: "https://shop.example.test/b", status: 302 },
                  ],
                  linkedFrom: [{ page: PAGE, html: '<a href="http://shop.example.test/a">A</a>' }],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(r.examples[0]!.after).toBe('<a href="https://shop.example.test/c">A</a>');
  });

  it("performance: shows only what was measured, with the lab caveat", () => {
    const g = buildIssueGuide(
      issue({
        category: "performance",
        ruleId: "lcp-slow",
        findings: [
          finding({
            evidence: [
              {
                kind: "measurement",
                data: {
                  metric: "lcp",
                  label: "Largest Contentful Paint",
                  unit: "ms",
                  values: { desktop: 4120.4, mobile: 5333 },
                  thresholds: { good: 2500, poor: 4000 },
                  lcpElement: "img",
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(g.facts).toEqual([
      { label: "Largest Contentful Paint (lab)", value: "desktop: 4120 ms · mobile: 5333 ms" },
      { label: "Thresholds", value: "good ≤ 2500 ms, poor > 4000 ms" },
      { label: "Largest element", value: "<img>", code: true },
    ]);
    expect(g.caveats.join(" ")).toMatch(/lab measurements from one scan/);
    expect(g.verify.join(" ")).toMatch(/vary from run to run/);
    // No measurement in the evidence: nothing is made up.
    expect(buildIssueGuide(issue({ category: "performance", ruleId: "tbt-slow" })).facts).toEqual(
      [],
    );
  });

  it("responsive: uses the measured widest element in the CSS example", () => {
    const g = buildIssueGuide(
      issue({
        category: "responsive",
        ruleId: "horizontal-overflow",
        findings: [
          finding({
            viewport: "mobile",
            evidence: [
              {
                kind: "measurement",
                data: {
                  viewportWidth: 375,
                  overflowPx: 145,
                  elements: [{ selector: "table.prices", right: 520 }],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(g.facts).toContainEqual({ label: "Page wider than the screen by", value: "145px" });
    expect(g.examples[0]!.after).toMatch(/^table\.prices \{\n {2}max-width: 100%;/);
    expect(g.caveats.join(" ")).toMatch(/overflow-x: hidden/);
  });

  it("design and content: before/after values both come from the evidence", () => {
    const d = buildIssueGuide(
      issue({
        category: "design",
        ruleId: "design-color-mismatch",
        findings: [
          finding({
            evidence: [
              {
                kind: "design_token",
                data: { token: "colors.primary", expected: "#0055ff", source: "Figma: Brand" },
              },
              {
                kind: "computed_style",
                data: {
                  property: "background-color",
                  mapping: "selector",
                  observations: [{ page: PAGE, actual: "#0044ee", selector: "a.btn", deltaE: 6.1 }],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(d.examples[0]).toMatchObject({
      before: "a.btn {\n  background-color: #0044ee;\n}",
      after: "a.btn {\n  background-color: #0055ff;\n}",
      beforeOrigin: "observed",
    });
    const c = buildIssueGuide(
      issue({
        category: "content",
        ruleId: "content-changed-wording",
        findings: [
          finding({
            evidence: [
              {
                kind: "document",
                data: { document: "copy.docx", location: "copy.docx, section Hero" },
              },
              {
                kind: "text_diff",
                data: { reference: "Book a free demo", website: "Book a demo", similarity: 0.88 },
              },
            ],
          }),
        ],
      }),
    );
    expect(c.examples[0]).toMatchObject({ before: "Book a demo", after: "Book a free demo" });
    expect(c.steps.join(" ")).toContain("copy.docx, section Hero");
  });
});

describe("summary, AI parts and coverage", () => {
  it("uses grounded AI text only for the parts it covers; code stays deterministic", () => {
    const base = issue({
      findings: [finding({ evidence: [{ kind: "axe_node", data: { html: NAV_ICON } }] })],
    });
    const plain = buildIssueGuide(base);
    const g = buildIssueGuide({
      ...base,
      explanation: {
        problem: "The mobile menu icon has no alt text.",
        steps: ["Step A", "Step B"],
      },
    });
    expect(g.problem).toBe("The mobile menu icon has no alt text.");
    expect(g.steps).toEqual(["Step A", "Step B"]);
    expect(g.aiParts).toEqual(["problem", "steps"]);
    expect(g.whyItMatters).toBe(plain.whyItMatters);
    expect(g.examples).toEqual(plain.examples);
    expect(plain.aiParts).toEqual([]);
  });

  it("notes when an example shows only one of several affected elements", () => {
    const g = buildIssueGuide(
      issue({
        findings: [
          finding({
            displayId: "A11Y-001",
            evidence: [{ kind: "axe_node", data: { html: '<img src="a.png">' } }],
          }),
          finding({
            displayId: "A11Y-002",
            evidence: [{ kind: "axe_node", data: { html: '<img src="b.png">' } }],
          }),
        ],
      }),
    );
    expect(g.examples[0]!.explanation).toMatch(/one of the 2 affected elements \(A11Y-001\)/);
  });

  it("builds a guide for every guided rule and category without evidence, inventing no URLs", () => {
    for (const [category, rules] of Object.entries(GUIDED_RULES))
      for (const ruleId of [...rules, "unknown-rule"]) {
        const input = issue({ category, ruleId });
        const g = buildIssueGuide(input);
        expect(g.problem && g.whyItMatters && g.nextAction).toBeTruthy();
        expect(g.steps.length).toBeGreaterThan(0);
        expect(g.verify.length).toBeGreaterThanOrEqual(5);
        expect(inventedUrls(input)).toEqual([]);
      }
    for (const category of ["design", "content", "unknown-category"])
      expect(buildIssueGuide(issue({ category, ruleId: "x" })).steps.length).toBeGreaterThan(0);
  });
});

describe("evidence recorded per page", () => {
  it("reads leaked server headers and page lists from the observations", () => {
    const g = buildIssueGuide(
      issue({
        category: "security",
        ruleId: "server-version-disclosure",
        findings: [
          finding({
            actual: "Server: nginx/1.18.0",
            evidence: [
              {
                kind: "header",
                data: {
                  affectedPages: 2,
                  pagesChecked: 2,
                  observations: [
                    { url: PAGE, headers: ["Server: nginx/1.18.0"] },
                    { url: `${PAGE}about`, headers: ["Server: nginx/1.18.0"] },
                  ],
                },
              },
            ],
          }),
        ],
      }),
    );
    expect(g.facts).toContainEqual({
      label: "Headers sent",
      value: "Server: nginx/1.18.0",
      code: true,
    });
    expect(g.examples[0]).toMatchObject({ before: "Server: nginx/1.18.0", after: "Server: nginx" });
    const canonical = buildIssueGuide(
      issue({
        category: "seo",
        ruleId: "canonical-missing",
        affectedUrls: [PAGE, `${PAGE}about`],
        findings: [
          finding({
            evidence: [{ kind: "document", data: { pages: [PAGE, `${PAGE}about`], omitted: 0 } }],
          }),
        ],
      }),
    );
    expect(canonical.facts).toContainEqual({
      label: "Pages without a canonical link",
      value: `${PAGE}, ${PAGE}about`,
      code: true,
    });
  });
});
