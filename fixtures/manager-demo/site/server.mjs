#!/usr/bin/env node
// Manager demo website for QA Copilot: "Brightline Studio", a FICTIONAL web agency.
// Every defect on these pages is intentional and documented in ../DATA_MANIFEST.md, so a real
// scan produces real, reproducible findings. Nothing here is a scan result; the scanners must
// find the defects themselves.
//
// Usage: node fixtures/manager-demo/site/server.mjs [port] [variant]
//   port     default 4100 (the only local port the default .env allows scanners to reach)
//   variant  "original" (default: all documented defects) or "fixed" (some defects repaired,
//            used to demonstrate a re-scan and the scan comparison)
// Switch the variant while it runs:  POST /__demo/variant with body "fixed" or "original".
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VARIANTS = ["original", "fixed"];

// Real Geist font file (SIL Open Font License 1.1, see ../fonts/OFL.txt), served as the site's
// web font. The same file is one of the font files uploaded to the QA Copilot project.
const GEIST = readFileSync(path.join(here, "../fonts/Geist-Variable-Latin.woff2"));

/** A real PNG with a smooth two-colour gradient (decodable by every browser). */
function gradientPng(width, height, [r1, g1, b1], [r2, g2, b2]) {
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      row[1 + x * 3] = Math.round(r1 + (r2 - r1) * t);
      row[2 + x * 3] = Math.round(g1 + (g2 - g1) * t);
      row[3 + x * 3] = Math.round(b1 + (b2 - b1) * t);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const IMAGES = {
  // 1600×640, shown at most 1152px wide: sharp (no defect).
  "/images/hero.png": gradientPng(1600, 640, [26, 86, 219], [17, 24, 39]),
  // 900×600 (3:2), drawn into a 600×250 box on /about: stretched (defect).
  "/images/team.png": gradientPng(900, 600, [243, 244, 246], [26, 86, 219]),
  // 48×48, drawn at 192×192 on /services: enlarged 4× (defect).
  "/images/icon-audit.png": gradientPng(48, 48, [26, 86, 219], [255, 255, 255]),
  // 96×96 shown at 48×48 on /services: sharp (no defect).
  "/images/icon-design.png": gradientPng(96, 96, [17, 24, 39], [26, 86, 219]),
};
// Not served (404): /images/award-badge.png, referenced on the home page (broken image).

const CSS = `@font-face{font-family:"Geist";src:url("/fonts/geist-variable-latin.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
*{box-sizing:border-box}
body{margin:0;font-family:"Geist",Arial,sans-serif;font-size:16px;line-height:24px;color:#1F2937;background:#FFFFFF}
header{background:#F3F4F6}
nav{max-width:1200px;margin:0 auto;padding:8px 24px;display:flex;flex-wrap:wrap;gap:24px}
nav a{display:inline-block;padding:8px 0;color:#1A56DB;font-weight:500;text-decoration:none}
main{max-width:1200px;margin:0 auto;padding:48px 24px}
h1{font-size:48px;line-height:56px;font-weight:700;color:#111827;margin:0 0 24px}
h2{font-size:32px;line-height:40px;font-weight:600;color:#111827;margin:48px 0 16px}
h3{font-size:24px;line-height:32px;font-weight:600;color:#111827;margin:0 0 8px}
p{margin:0 0 16px}
a{color:#1A56DB}
ul{margin:0 0 16px;padding-left:24px}
img{max-width:100%;height:auto;display:block}
.btn-primary{display:inline-block;background:#1A56DB;color:#FFFFFF;border-radius:8px;padding:12px 24px;text-decoration:none;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px;margin-bottom:32px}
.card{padding:24px;border:1px solid #E5E7EB;border-radius:8px}
.hero{margin:32px 0}
form{display:grid;gap:16px;max-width:560px}
label{font-weight:600}
input,textarea{font:inherit;padding:12px;border:1px solid #9CA3AF;border-radius:8px}
footer{background:#111827;color:#F9FAFB;padding:24px}
footer p{max-width:1200px;margin:0 auto}`;

const layout = (v, { title, description, path: p, body, head = "" }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? `<meta name="description" content="${description}">` : ""}
<link rel="canonical" href="${p}">
<link rel="stylesheet" href="/assets/site.css">
${head}
</head>
<body class="page-${p === "/" ? "home" : p.slice(1)}">
<header><nav aria-label="Main">
  <a href="/">Home</a>
  <a href="/about">About</a>
  <a href="/services">Services</a>
  <a href="/contact">Contact</a>
</nav></header>
<main>
${body}
</main>
<footer><p>© 2026 Brightline Studio. Demo website for QA Copilot (a fictional company).</p></footer>
</body>
</html>`;

const fixed = (v) => v === "fixed";

const PAGES = {
  "/": (v) =>
    layout(v, {
      title: "Brightline Studio – Websites your brand team signs off",
      description:
        "Brightline Studio designs, builds and checks marketing websites that match your brand guidelines.",
      path: "/",
      body: `<h1>Websites your brand team signs off</h1>
<p class="lead">Brightline Studio designs, builds and checks marketing websites so every page matches your brand guidelines.</p>
<p><a class="btn-primary" href="/contact">${fixed(v) ? "Book a free consultation" : "Book a consultation"}</a></p>
<img class="hero" src="/images/hero.png" width="1600" height="640" alt="Brightline Studio project overview">
<h2>What we do</h2>
<div class="cards">
  <div class="card"><h3>Brand-accurate design</h3><p>Typography, colour and spacing taken straight from your brand guidelines.</p></div>
  <div class="card"><h3>Accessible by default</h3><p>Every component is tested with keyboards and screen readers.</p></div>
  <div class="card"><h3>Fast, reliable pages</h3><p>Lean pages that load quickly on any device.</p></div>
</div>
<h2>Recent work</h2>
<p>See projects for retail, finance and healthcare clients. <a href="/case-studies">Read our case studies</a></p>
<img src="/images/award-badge.png" width="160" height="160" alt="Design award badge">`,
    }),
  "/about": (v) =>
    layout(v, {
      title: "About us – Brightline Studio",
      description: "Meet the Brightline Studio team and the values behind our work.",
      path: "/about",
      head: fixed(v) ? "" : `<style>.page-about h1{font-size:40px;line-height:48px}</style>`,
      body: `<h1>About Brightline Studio</h1>
<p>We are a team of designers, developers and QA specialists based in Pune and London.</p>
${fixed(v) ? "<p>Since 2015 we have delivered more than 300 websites for brands in 12 countries.</p>" : ""}
<h2>Our values</h2>
<ul>
  <li>Measure everything.</li>
  <li>Explain every fix.</li>
  <li>Ship only what we have verified.</li>
</ul>
<img class="team-photo" src="/images/team.png" width="900" height="600"${fixed(v) ? ' alt="The Brightline Studio team"' : ""}>
<style>.team-photo{width:600px;height:250px}</style>
<p><a class="btn-primary" href="/contact">Meet the team</a></p>`,
    }),
  "/services": (v) =>
    layout(v, {
      title: "Services – Brightline Studio",
      description: fixed(v)
        ? "Design systems, website builds and QA audits from Brightline Studio."
        : "",
      path: "/services",
      head: `<style>
.service-card{padding:24px;border:1px solid #E5E7EB;border-radius:8px}
.service-card+.service-card{margin-top:24px}
${fixed(v) ? "" : ".service-card.featured{margin-top:48px}"}
.service-card h2.promo{font-size:26px;line-height:32px;font-weight:400}
.service-icon{width:192px;height:192px;margin-bottom:16px}
.service-icon.small{width:48px;height:48px}
</style>`,
      body: `<h1>Our services</h1>
<p class="lead">Three ways we help your team launch and maintain websites with confidence.</p>
<div class="service-list">
  <div class="service-card"><img class="service-icon small" src="/images/icon-design.png" width="96" height="96" alt=""><h2>Design systems</h2><p>Reusable components and tokens built from your brand guidelines.</p></div>
  <div class="service-card featured"><h2>Website builds</h2><p>Fast, accessible websites built on the platform you already use.</p></div>
  <div class="service-card"><img class="service-icon" src="/images/icon-audit.png" width="48" height="48" alt=""><h2 class="promo">QA audits</h2><p>Automated and manual checks of design, content, accessibility and performance.</p></div>
</div>
<p><a class="btn-primary" href="/contact">Start a project</a></p>`,
    }),
  "/contact": (v) =>
    layout(v, {
      title: "Contact – Brightline Studio",
      description: "Tell Brightline Studio about your project. We reply within one business day.",
      path: "/contact",
      body: `<h1>Contact us</h1>
<p>Tell us about your project and we will reply within one business day.</p>
<form action="/contact" method="get">
  <label for="name">Your name</label>
  <input id="name" name="name" autocomplete="name">
  ${fixed(v) ? '<label for="email">Email address</label>' : ""}
  <input${fixed(v) ? ' id="email"' : ""} name="email" type="email" autocomplete="email">
  <label for="details">Project details</label>
  <textarea id="details" name="details" rows="4"></textarea>
  <p><button class="btn-primary" type="submit">Send message</button></p>
</form>
<p>Prefer email? Write to hello@brightline.example.</p>`,
    }),
  // Not linked from any page: reachable only when added as a page link in QA Copilot.
  "/design-lab": () =>
    layout("original", {
      title: "Design lab – Brightline Studio",
      description: "Typography and layout experiments for the next Brightline Studio release.",
      path: "/design-lab",
      head: `<style>
@font-face{font-family:"Geist Display";src:url("/fonts/geist-display.woff2") format("woff2")}
.display{font-family:"Geist Display","Geist",Arial,sans-serif;font-size:20px;line-height:32px}
.page-design-lab h3{font-size:36px;line-height:44px}
.stack>div{width:480px;padding:16px;background:#F3F4F6}
.stack .b{margin-left:3px;margin-top:8px}
.banner{width:1100px;padding:24px;background:#E5E7EB}
</style>`,
      body: `<h1>Design lab</h1>
<p class="display">This introduction asks for the Geist Display web font, whose file has not been published yet.</p>
<h2>Section heading</h2>
<p>Sections on this page are used to try new layouts before they reach the main website.</p>
<h3>A subsection drawn larger than its section</h3>
<p>The subsection heading above is styled larger than the section heading.</p>
<div class="stack"><div class="a">Block A starts at the content edge.</div><div class="b">Block B starts 3px further right.</div></div>
<h2>Wide banner</h2>
<div class="banner">This banner has a fixed width of 1100px and does not fit on phones.</div>`,
    }),
};

/** Creates the demo server; `state.variant` can be switched while it runs. */
export function createManagerDemoServer(state = { variant: "original" }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://demo.local");
    const p = url.pathname;
    const host = req.headers.host ?? "localhost";
    if (p === "/__demo/variant") {
      const reply = () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(state.variant);
      };
      if (req.method !== "POST") return reply();
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!VARIANTS.includes(body.trim())) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end(`Unknown variant; use one of: ${VARIANTS.join(", ")}`);
        }
        state.variant = body.trim();
        reply();
      });
      return;
    }
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`User-agent: *\nAllow: /\nSitemap: http://${host}/sitemap.xml\n`);
    }
    if (p === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/about", "/services", "/contact"].map((u) => `  <url><loc>http://${host}${u}</loc></url>`).join("\n")}\n</urlset>\n`,
      );
    }
    if (p === "/assets/site.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      return res.end(CSS);
    }
    if (p === "/fonts/geist-variable-latin.woff2") {
      res.writeHead(200, { "content-type": "font/woff2", "content-length": GEIST.length });
      return res.end(GEIST);
    }
    if (IMAGES[p]) {
      res.writeHead(200, { "content-type": "image/png", "content-length": IMAGES[p].length });
      return res.end(IMAGES[p]);
    }
    const page = PAGES[p];
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(state.variant));
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(
      layout(state.variant, {
        title: "Page not found – Brightline Studio",
        description: "",
        path: p,
        body: "<h1>Page not found</h1><p>The page you are looking for does not exist.</p>",
      }),
    );
  });
}

export function startManagerDemo(port = 4100, { variant = "original" } = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown variant: ${variant}`);
  const state = { variant };
  const server = createManagerDemoServer(state);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://localhost:${actual}/`,
        setVariant: (next) => (state.variant = next),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.MANAGER_DEMO_PORT ?? 4100);
  const variant = process.argv[3] ?? "original";
  startManagerDemo(port, { variant }).then(
    ({ url }) => console.log(`Brightline Studio demo website (${variant}) running at ${url}`),
    (err) => {
      console.error(
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use. Stop the other program on it (for example \`npm run demo:site\`) and try again.`
          : err.message,
      );
      process.exit(1);
    },
  );
}
