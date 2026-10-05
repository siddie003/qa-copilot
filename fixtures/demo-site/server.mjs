#!/usr/bin/env node
// Controlled fixture website used by integration/E2E tests and demo mode.
// Every behavior and defect here is intentional and documented in fixtures/demo-site/README.md.
// Usage: node fixtures/demo-site/server.mjs [port] [variant]   (default 4100 and v1, binds 127.0.0.1)
// Variant "v2" is the "next release" of the site (some defects fixed, one added, one page
// failing) used to verify scan comparisons; switch at runtime with POST /__fixture/variant.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const MEMBERS_USER = "qa";
export const MEMBERS_PASSWORD = "demo-pass";

const layout = (
  title,
  body,
  { extraHead = "", description = `${title} – Demo Store` } = {},
) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ""}
${extraHead}
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header><nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/products">Products</a>
  <a href="/blog/">Blog</a>
  <a href="/contact">Contact</a>
</nav></header>
<main>
${body}
</main>
<footer><p>QA Copilot demo fixture site</p></footer>
</body>
</html>`;

export const VARIANTS = ["v1", "v2"];

/** Page renderers; `v` is the site variant ("v1" = documented defects, "v2" = next release). */
const PAGES = {
  "/": (v) =>
    layout(
      "Demo Store – Home",
      `<h1>Welcome to the Demo Store</h1>
<p>Fixture homepage with known link behaviors.</p>
<!-- deploy note: AKIAIOSFODNN7EXAMPLE (example credential left in a comment) -->
<ul>
  <li><a href="/about?utm_source=newsletter">About (tracking parameter duplicate)</a></li>
  <li><a href="/old-page">Old page (301 to /about)</a></li>
  <li><a href="/chain-start">Redirect chain (302 → 301 → /products)</a></li>
  <li><a href="/private/secret">Private area (disallowed by robots.txt)</a></li>
  <li><a href="/missing">Missing page (404)</a></li>
  <li><a href="/server-error">Always failing page (500)</a></li>
  <li><a href="/members">Members area (HTTP Basic authentication)</a></li>
  <li><a href="/wide">Wide layout</a></li>
  <li><a href="/slow">Slow page</a></li>
  <li><a href="/docs/guide.pdf">Guide (PDF resource, not a page)</a></li>
  <li><a href="https://example.org/partner">External partner site</a></li>
  <li><a href="mailto:hello@example.test">Email us</a></li>
  <li><a href="#top">Back to top</a></li>
</ul>
<img src="/images/hero.png" alt="Hero banner" width="1200" height="400">
<div id="js-links"></div>
<script>
  // This link only exists after JavaScript runs (tests JS-rendered link discovery).
  var a = document.createElement("a");
  a.href = "/js-only";
  a.textContent = "Rendered by JavaScript";
  document.getElementById("js-links").appendChild(a);
  console.error("Fixture: intentional console error on the homepage");
</script>`,
      {
        // Render-blocking script and invalid JSON-LD (missing closing brace) are intentional.
        // v2 fixes the JSON-LD.
        extraHead: `<script src="/assets/app.js"></script>
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Organization", "name": "Demo Store"${v === "v2" ? "}" : ""}</script>`,
      },
    ),
  // v2 adds the missing meta description and the image's alt text.
  "/about": (v) =>
    layout(
      "About us",
      `<h1>About us</h1>
<p>We sell demo products.</p>
<p>Our team ships quality products to customers every week.</p>
<h2>Our mission</h2>
<p>Make QA simple for every team. Read our <a href="/blog/">blog</a> for updates.</p>
<p><a class="btn-primary" href="/blog/">Contact our team</a></p>
<img src="/images/team.png"${v === "v2" ? ' alt="Our team"' : ""} width="40" height="40">`,
      {
        description:
          v === "v2"
            ? "Learn about the Demo Store team, our mission and how we ship quality demo products."
            : null,
      },
    ),
  "/products": () =>
    layout(
      "Products",
      `<h1>Products</h1>
<p style="color:#c4c4c4;background:#ffffff">Prices include VAT (low-contrast text).</p>
<p>Browse our full range of widgets and gadgets.</p>
<ul><li><a href="/products/widget">Widget</a></li><li><a href="/products/gadget">Gadget</a></li></ul>`,
    ),
  "/products/widget": () => layout("Product", `<h1>Widget</h1><p>A very useful widget.</p>`),
  "/products/gadget": () =>
    layout(
      "Product",
      `<h1>Gadget</h1><p>A shiny gadget.</p><img src="/images/missing.png" alt="Gadget photo" width="200" height="200">`,
    ),
  "/contact": () =>
    layout(
      "Contact",
      `<h1>Contact</h1>
<form action="/contact" method="post"><input type="email" name="email"><button>Send</button></form>
<button style="width:16px;height:16px;padding:0;font-size:8px;line-height:8px"><span aria-hidden="true">?</span></button>
<div style="position:relative;height:48px">
  <a href="/about" style="position:absolute;left:0;top:0;padding:12px;background:#eef">About the team</a>
  <a href="/blog/" style="position:absolute;left:40px;top:6px;padding:12px;background:#fee">Read the blog</a>
</div>`,
    ),
  "/blog/": () =>
    layout(
      "Blog",
      `<h1>Blog</h1><a href="/blog/post-1">Post 1</a> <a href="/blog/post-2">Post 2</a>`,
    ),
  // v2 introduces a new defect: the post has no H1 (its heading became an H2).
  "/blog/post-1": (v) =>
    layout(
      "Post 1",
      `${v === "v2" ? "<h2>Post 1</h2>" : "<h1>Post 1</h1>"}<p>First post.</p><a href="/blog/archive">Archive</a>`,
    ),
  "/blog/post-2": () =>
    layout(
      "Post 2",
      `<h1>Post 2</h1><h4>Skipped heading levels</h4><h1>A second main heading</h1><p>Second post.</p>`,
    ),
  "/blog/archive": () =>
    layout("Archive", `<h1>Archive</h1><a href="/blog/archive/2019">2019 posts</a>`),
  "/blog/archive/2019": () => layout("2019", `<h1>2019</h1><p>Depth 4 from the homepage.</p>`),
  "/js-only": () => layout("JS only", `<h1>Reached via a JavaScript-rendered link</h1>`),
  "/private/secret": () => layout("Secret", `<h1>Private</h1>`),
  "/wide": () =>
    layout(
      "Wide layout",
      `<h1>Wide layout</h1>
<div style="width:1100px;background:#eee">This banner has a fixed width of 1100px.</div>
<div style="width:120px;overflow:hidden;white-space:nowrap;border:1px solid #999">This sentence is far too long to fit inside its narrow box</div>`,
    ),
  "/slow": () =>
    layout("Slow page", `<h1>Slow page</h1><p>The server waits 1.5 s before answering.</p>`),
  "/members": () =>
    layout("Members", `<h1>Members area</h1><a href="/members/profile">Your profile</a>`),
  "/members/profile": () => layout("Profile", `<h1>Your profile</h1>`),
};

const REDIRECTS = {
  "/old-page": [301, "/about"],
  "/chain-start": [302, "/chain-mid"],
  "/chain-mid": [301, "/products"],
};

// Design values differ from fixtures/documents/design-spec.json on purpose (see README).
const CSS = [
  "body{font-family:system-ui;margin:0;color:#222222;background:#ffffff}",
  "main{padding:1rem}",
  "header{background:#f1f5f9}",
  "h1{font-family:Georgia,serif;font-size:40px;font-weight:700;color:#1a1a2e}",
  "a{color:#0645ad}",
  ".btn-primary{display:inline-block;background:#1d4ed8;color:#ffffff;border-radius:6px;padding:12px 24px;text-decoration:none}",
].join("");
const APP_JS = "window.demoReady = true;";

/** A real, decodable PNG of random pixels (incompressible, ~360 KB). */
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0]), randomBytes(width * 3));
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const HERO = makePng(600, 200);
const TEAM = makePng(40, 40);

const BASIC = `Basic ${Buffer.from(`${MEMBERS_USER}:${MEMBERS_PASSWORD}`).toString("base64")}`;

const VARIANT_PATH = "/__fixture/variant";

/**
 * Creates the fixture server. `state.variant` selects the site version and can be changed while
 * the server runs (directly, or with `POST /__fixture/variant` and the variant name as body).
 * A request header `X-Fixture-Variant: v1|v2` overrides it for that request only, so a project
 * can scan another variant (sent as its custom-header site credentials) without affecting other
 * scans of the same server. The toggle path is not linked from any page, so scans never find it.
 */
export function createDemoSiteServer(state = { variant: "v1" }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    if (path === VARIANT_PATH) {
      const reply = () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(state.variant);
      };
      if (req.method !== "POST") return reply();
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const next = body.trim();
        if (!VARIANTS.includes(next)) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end(`Unknown variant; use one of: ${VARIANTS.join(", ")}`);
        }
        state.variant = next;
        reply();
      });
      return;
    }
    const requested = req.headers["x-fixture-variant"];
    const variant = VARIANTS.includes(requested) ? requested : state.variant;
    // Version disclosure and cookie without security flags are intentional.
    res.setHeader("Server", "DemoServer/1.2.3");
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n");
    }
    if (REDIRECTS[path]) {
      const [status, location] = REDIRECTS[path];
      res.writeHead(status, { location });
      return res.end();
    }
    // v2: the wide-layout page fails, so its earlier issues cannot be re-checked.
    if (path === "/server-error" || (path === "/wide" && variant === "v2")) {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<h1>Internal error</h1>");
    }
    if (path.startsWith("/members")) {
      if (req.headers.authorization !== BASIC) {
        res.writeHead(401, {
          "www-authenticate": 'Basic realm="Demo members"',
          "content-type": "text/html",
        });
        return res.end("<h1>Login required</h1>");
      }
    }
    if (path === "/assets/site.css") {
      res.writeHead(200, { "content-type": "text/css" });
      return res.end(CSS);
    }
    if (path === "/assets/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(APP_JS);
    }
    if (path === "/images/hero.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": HERO.length });
      return res.end(HERO);
    }
    if (path === "/images/team.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": TEAM.length });
      return res.end(TEAM);
    }
    if (path === "/docs/guide.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-1.4 fixture");
    }
    const page = PAGES[path];
    if (page) {
      const send = () => {
        const headers = { "content-type": "text/html; charset=utf-8" };
        if (path === "/") headers["set-cookie"] = "demo_session=abc123; Path=/";
        res.writeHead(200, headers);
        res.end(page(variant));
      };
      if (path === "/slow") return void setTimeout(send, 1500);
      return send();
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(layout("Not found", "<h1>404 – Page not found</h1>"));
  });
}

export const HERO_PNG_BYTES = HERO.length;

/** Starts the fixture on 127.0.0.1. Port 0 picks a free port. */
export function startDemoSite(port = 4100, { variant = "v1" } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown fixture variant: ${variant}`);
  const state = { variant };
  const server = createDemoSiteServer(state);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://localhost:${actual}/`,
        variant: () => state.variant,
        setVariant: (next) => {
          if (!VARIANTS.includes(next)) throw new Error(`Unknown fixture variant: ${next}`);
          state.variant = next;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.DEMO_SITE_PORT ?? 4100);
  const variant = process.argv[3] ?? process.env.DEMO_SITE_VARIANT ?? "v1";
  startDemoSite(port, { variant }).then(({ url }) =>
    console.log(`Demo fixture site (${variant}) running at ${url}`),
  );
}
