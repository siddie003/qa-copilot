export type Confidence = "high" | "medium" | "low";

export interface DetectedTechnology {
  name: string;
  category: "cms" | "framework" | "ecommerce" | "language" | "server" | "hosting";
  confidence: Confidence;
  /** Exactly what was observed, so the detection can be verified. */
  signals: string[];
}

export interface TechnologyInput {
  url: string;
  headers: Record<string, string | string[]>;
  html: string | null;
}

interface Rule {
  name: string;
  category: DetectedTechnology["category"];
  checks: Array<{ test: (i: Ctx) => boolean; signal: string; weight: Confidence }>;
}

interface Ctx {
  url: string;
  html: string;
  header: (k: string) => string;
  cookies: string;
}

const RULES: Rule[] = [
  {
    name: "WordPress",
    category: "cms",
    checks: [
      {
        test: (c) => /<meta[^>]+name=["']generator["'][^>]+wordpress/i.test(c.html),
        signal: 'meta generator "WordPress"',
        weight: "high",
      },
      {
        test: (c) => /\/wp-(content|includes)\//i.test(c.html),
        signal: "/wp-content/ or /wp-includes/ asset paths",
        weight: "high",
      },
      {
        test: (c) => /wp-json/i.test(c.header("link")),
        signal: "Link header points to /wp-json",
        weight: "high",
      },
    ],
  },
  {
    name: "Shopify",
    category: "ecommerce",
    checks: [
      {
        test: (c) => /cdn\.shopify\.com/i.test(c.html),
        signal: "assets from cdn.shopify.com",
        weight: "high",
      },
      {
        test: (c) => Boolean(c.header("x-shopid") || c.header("x-shopify-stage")),
        signal: "x-shopid / x-shopify-stage header",
        weight: "high",
      },
      {
        test: (c) => /Shopify\.theme/.test(c.html),
        signal: "Shopify.theme script object",
        weight: "high",
      },
    ],
  },
  {
    name: "Next.js",
    category: "framework",
    checks: [
      {
        test: (c) => /next\.js/i.test(c.header("x-powered-by")),
        signal: "x-powered-by: Next.js",
        weight: "high",
      },
      {
        test: (c) => /id=["']__NEXT_DATA__["']/.test(c.html),
        signal: "__NEXT_DATA__ script",
        weight: "high",
      },
      {
        test: (c) => /\/_next\/static\//.test(c.html),
        signal: "/_next/static/ asset paths",
        weight: "high",
      },
      {
        test: (c) => Boolean(c.header("x-nextjs-cache") || c.header("x-nextjs-prerender")),
        signal: "x-nextjs-* header",
        weight: "high",
      },
    ],
  },
  {
    name: "Nuxt",
    category: "framework",
    checks: [
      {
        test: (c) => /window\.__NUXT__|id=["']__nuxt["']/.test(c.html),
        signal: "__NUXT__ / #__nuxt",
        weight: "high",
      },
      { test: (c) => /\/_nuxt\//.test(c.html), signal: "/_nuxt/ asset paths", weight: "high" },
    ],
  },
  {
    name: "Gatsby",
    category: "framework",
    checks: [
      {
        test: (c) => /id=["']___gatsby["']/.test(c.html),
        signal: "#___gatsby root",
        weight: "high",
      },
    ],
  },
  {
    name: "React",
    category: "framework",
    checks: [
      {
        test: (c) => /data-reactroot|data-reactid/.test(c.html),
        signal: "data-reactroot attribute",
        weight: "medium",
      },
      {
        test: (c) => /react(-dom)?(\.production)?(\.min)?\.js/i.test(c.html),
        signal: "react-dom script",
        weight: "medium",
      },
      {
        test: (c) => /id=["']__NEXT_DATA__["']|\/_next\/static\/|id=["']___gatsby["']/.test(c.html),
        signal: "React-based framework detected",
        weight: "medium",
      },
    ],
  },
  {
    name: "Vue",
    category: "framework",
    checks: [
      {
        test: (c) => /\sdata-v-[0-9a-f]{6,}/.test(c.html),
        signal: "data-v-* scoped style attributes",
        weight: "medium",
      },
    ],
  },
  {
    name: "Angular",
    category: "framework",
    checks: [
      {
        test: (c) => /\sng-version=["']/.test(c.html),
        signal: "ng-version attribute",
        weight: "high",
      },
    ],
  },
  {
    name: "Drupal",
    category: "cms",
    checks: [
      {
        test: (c) => /<meta[^>]+name=["']generator["'][^>]+drupal/i.test(c.html),
        signal: 'meta generator "Drupal"',
        weight: "high",
      },
      {
        test: (c) => /drupal/i.test(c.header("x-generator")),
        signal: "x-generator: Drupal",
        weight: "high",
      },
    ],
  },
  {
    name: "Wix",
    category: "cms",
    checks: [
      {
        test: (c) =>
          /static\.wixstatic\.com|x-wix-request-id/i.test(c.html + c.header("x-wix-request-id")),
        signal: "Wix assets or headers",
        weight: "high",
      },
    ],
  },
  {
    name: "Squarespace",
    category: "cms",
    checks: [
      {
        test: (c) => /static1\.squarespace\.com/i.test(c.html),
        signal: "assets from static1.squarespace.com",
        weight: "high",
      },
    ],
  },
  {
    name: "PHP",
    category: "language",
    checks: [
      {
        test: (c) => /php/i.test(c.header("x-powered-by")),
        signal: "x-powered-by: PHP",
        weight: "high",
      },
      { test: (c) => /PHPSESSID=/i.test(c.cookies), signal: "PHPSESSID cookie", weight: "medium" },
      {
        test: (c) => /\.php(\?|$)/i.test(new URL(c.url).pathname),
        signal: ".php URL",
        weight: "low",
      },
    ],
  },
];

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * Detects technologies from response headers and served HTML. Detection is heuristic: every
 * result lists the signals it is based on, and an empty list means "could not determine".
 */
export function detectTechnology(input: TechnologyInput): DetectedTechnology[] {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers))
    lower[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  const ctx: Ctx = {
    url: input.url,
    html: input.html ?? "",
    header: (k) => lower[k] ?? "",
    cookies: lower["set-cookie"] ?? "",
  };
  const found: DetectedTechnology[] = [];
  for (const rule of RULES) {
    const hits = rule.checks.filter((c) => {
      try {
        return c.test(ctx);
      } catch {
        return false;
      }
    });
    if (!hits.length) continue;
    const best = hits.reduce((a, b) => (RANK[b.weight] > RANK[a.weight] ? b : a));
    const confidence: Confidence =
      hits.length >= 2 && best.weight === "medium" ? "high" : best.weight;
    found.push({
      name: rule.name,
      category: rule.category,
      confidence,
      signals: hits.map((h) => h.signal),
    });
  }
  const server = ctx.header("server");
  if (server)
    found.push({
      name: server.split(/[\s/]/)[0]!,
      category: "server",
      confidence: "high",
      signals: [`server: ${server}`],
    });
  return found.sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
}
