#!/usr/bin/env node
// Checks that the Brightline Studio demo website answers every documented URL as expected.
// Usage:
//   node fixtures/manager-demo/verify-demo-site.mjs                       (starts a private copy)
//   node fixtures/manager-demo/verify-demo-site.mjs http://localhost:4100 (checks a running one)
// It only reads pages; it changes nothing (it never switches the variant of a running site).
import { startManagerDemo } from "./site/server.mjs";

const EXPECTED = [
  ["/", 200, "text/html", "Websites your brand team signs off"],
  ["/about", 200, "text/html", "About Brightline Studio"],
  ["/services", 200, "text/html", "Our services"],
  ["/contact", 200, "text/html", "Contact us"],
  ["/design-lab", 200, "text/html", "Design lab"],
  ["/case-studies", 404, "text/html", "Page not found"],
  ["/images/award-badge.png", 404, "text/html", null],
  ["/images/hero.png", 200, "image/png", null],
  ["/images/team.png", 200, "image/png", null],
  ["/images/icon-audit.png", 200, "image/png", null],
  ["/fonts/geist-variable-latin.woff2", 200, "font/woff2", null],
  ["/fonts/geist-display.woff2", 404, "text/html", null],
  ["/assets/site.css", 200, "text/css", "Geist"],
  ["/robots.txt", 200, "text/plain", "Sitemap:"],
  ["/sitemap.xml", 200, "application/xml", "/services"],
];

const given = process.argv[2];
const own = given ? null : await startManagerDemo(0);
const base = (given ?? own.url).replace(/\/$/, "");
let failures = 0;
console.log(`Checking ${base} …`);
for (const [p, status, type, text] of EXPECTED) {
  let line;
  try {
    const res = await fetch(base + p, { redirect: "manual" });
    const body = await res.text();
    const ok =
      res.status === status &&
      (res.headers.get("content-type") ?? "").startsWith(type) &&
      (!text || body.includes(text));
    if (!ok) failures += 1;
    line = `${ok ? "OK  " : "FAIL"} ${String(res.status).padEnd(4)} ${p}${ok ? "" : `  (expected ${status} ${type}${text ? ` containing “${text}”` : ""})`}`;
  } catch (err) {
    failures += 1;
    line = `FAIL ---  ${p}  (${err.message}; is the demo website running?)`;
  }
  console.log(line);
}
const variant = await fetch(`${base}/__demo/variant`).then(
  (r) => r.text(),
  () => "unknown",
);
console.log(`Variant: ${variant}`);
console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
await own?.close();
process.exit(failures ? 1 : 0);
