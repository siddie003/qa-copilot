#!/usr/bin/env node
// Controlled fixture website used by integration/E2E tests and demo mode.
// Every behavior here is intentional and documented in fixtures/demo-site/README.md.
// Usage: node fixtures/demo-site/server.mjs [port]   (default 4100, binds 127.0.0.1)
import http from "node:http";
import { fileURLToPath } from "node:url";

const layout = (title, body, { extraHead = "" } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${extraHead}
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header><nav>
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

const PAGES = {
  "/": () =>
    layout(
      "Demo Store – Home",
      `<h1>Welcome to the Demo Store</h1>
<p>Fixture homepage with known link behaviors.</p>
<ul>
  <li><a href="/about?utm_source=newsletter">About (tracking parameter duplicate)</a></li>
  <li><a href="/old-page">Old page (301 to /about)</a></li>
  <li><a href="/chain-start">Redirect chain (302 → 301 → /products)</a></li>
  <li><a href="/private/secret">Private area (disallowed by robots.txt)</a></li>
  <li><a href="/missing">Missing page (404)</a></li>
  <li><a href="/server-error">Always failing page (500)</a></li>
  <li><a href="/docs/guide.pdf">Guide (PDF resource, not a page)</a></li>
  <li><a href="https://example.org/partner">External partner site</a></li>
  <li><a href="mailto:hello@example.test">Email us</a></li>
  <li><a href="#top">Back to top</a></li>
</ul>
<img src="/images/hero.jpg" alt="Hero banner" width="1200" height="400">
<div id="js-links"></div>
<script>
  // This link only exists after JavaScript runs (tests JS-rendered link discovery).
  var a = document.createElement("a");
  a.href = "/js-only";
  a.textContent = "Rendered by JavaScript";
  document.getElementById("js-links").appendChild(a);
  console.error("Fixture: intentional console error on the homepage");
</script>`,
    ),
  "/about": () => layout("About us", `<h1>About us</h1><p>We sell demo products.</p>`),
  "/products": () =>
    layout(
      "Products",
      `<h1>Products</h1><ul><li><a href="/products/widget">Widget</a></li><li><a href="/products/gadget">Gadget</a></li></ul>`,
    ),
  "/products/widget": () => layout("Widget", `<h1>Widget</h1><p>A very useful widget.</p>`),
  "/products/gadget": () => layout("Gadget", `<h1>Gadget</h1><p>A shiny gadget.</p>`),
  "/contact": () =>
    layout(
      "Contact",
      `<h1>Contact</h1><form action="/contact" method="post"><input type="email" name="email"><button>Send</button></form>`,
    ),
  "/blog/": () =>
    layout(
      "Blog",
      `<h1>Blog</h1><a href="/blog/post-1">Post 1</a> <a href="/blog/post-2">Post 2</a>`,
    ),
  "/blog/post-1": () =>
    layout("Post 1", `<h1>Post 1</h1><p>First post.</p><a href="/blog/archive">Archive</a>`),
  "/blog/post-2": () => layout("Post 2", `<h1>Post 2</h1><p>Second post.</p>`),
  "/blog/archive": () =>
    layout("Archive", `<h1>Archive</h1><a href="/blog/archive/2019">2019 posts</a>`),
  "/blog/archive/2019": () => layout("2019", `<h1>2019</h1><p>Depth 4 from the homepage.</p>`),
  "/js-only": () => layout("JS only", `<h1>Reached via a JavaScript-rendered link</h1>`),
  "/private/secret": () => layout("Secret", `<h1>Private</h1>`),
};

const REDIRECTS = {
  "/old-page": [301, "/about"],
  "/chain-start": [302, "/chain-mid"],
  "/chain-mid": [301, "/products"],
};

const CSS = "body{font-family:system-ui;margin:0}main{padding:1rem}";
// ~300 KB of bytes served as an image so performance checks have something measurable.
const HERO = Buffer.alloc(300 * 1024, 0x42);

export function createDemoSiteServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    const path = url.pathname;
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n");
    }
    if (REDIRECTS[path]) {
      const [status, location] = REDIRECTS[path];
      res.writeHead(status, { location });
      return res.end();
    }
    if (path === "/server-error") {
      res.writeHead(500, { "content-type": "text/html" });
      return res.end("<h1>Internal error</h1>");
    }
    if (path === "/assets/site.css") {
      res.writeHead(200, { "content-type": "text/css" });
      return res.end(CSS);
    }
    if (path === "/images/hero.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": HERO.length });
      return res.end(HERO);
    }
    if (path === "/docs/guide.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end("%PDF-1.4 fixture");
    }
    const page = PAGES[path];
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(layout("Not found", "<h1>404 – Page not found</h1>"));
  });
}

/** Starts the fixture on 127.0.0.1. Port 0 picks a free port. */
export function startDemoSite(port = 4100) {
  const server = createDemoSiteServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://localhost:${actual}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.DEMO_SITE_PORT ?? 4100);
  startDemoSite(port).then(({ url }) => console.log(`Demo fixture site running at ${url}`));
}
