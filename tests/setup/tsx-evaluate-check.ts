// Regression check (run with tsx): page capture must work when compiled by tsx/esbuild, which
// injects __name() helpers. Usage: npx tsx tests/setup/tsx-evaluate-check.ts
import { startDemoSite } from "../../fixtures/demo-site/server.mjs";
import { capturePage, launchBrowser, newGuardedContext } from "../../packages/browser/src/index";

const site = await startDemoSite(0);
const session = await launchBrowser();
const viewport = { name: "desktop", width: 1280, height: 800 };
const { context, guard } = await newGuardedContext(session, {
  viewport,
  userAgent: "QACopilotCheck",
  policy: { allowedPrivateHosts: [`localhost:${site.port}`] },
});
const r = await capturePage(context, guard, site.url, viewport, {
  timeoutMs: 15_000,
  screenshot: true,
});
await session.close();
await site.close();
if (r.error || !r.screenshot || !r.timings.loadMs) {
  console.error("FAIL", r.error, r.timings);
  process.exit(1);
}
console.log("OK: capture works under tsx", {
  loadMs: r.timings.loadMs,
  bytes: r.screenshot.length,
});
