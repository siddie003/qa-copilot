import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoSite } from "../../../fixtures/demo-site/server.mjs";
import {
  capturePage,
  launchBrowser,
  newGuardedContext,
  renderLinks,
  type BrowserSession,
} from "./index";

// Real Chromium against the local fixture site.
describe("browser capture", () => {
  let session: BrowserSession;
  let site: Awaited<ReturnType<typeof startDemoSite>>;
  let internal: http.Server;
  let internalPort: number;

  beforeAll(async () => {
    session = await launchBrowser();
    site = await startDemoSite(0);
    // A second local server that the fixture's allowlist does NOT cover.
    internal = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<h1>t</h1><img src="http://127.0.0.1:${internalPort}/secret.png">`);
      }
      res.end("secret");
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    internalPort = (internal.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    await session?.close();
    await site?.close();
    await new Promise<void>((r) => internal.close(() => r()));
  });

  const policy = () => ({
    allowedPrivateHosts: [`localhost:${site.port}`, `localhost:${internalPort}`],
  });

  it("captures DOM, screenshot, network, console and timings at desktop size", async () => {
    const viewport = { name: "desktop", width: 1440, height: 900 };
    const { context, guard } = await newGuardedContext(session, {
      viewport,
      userAgent: "QACopilotTest",
      policy: policy(),
    });
    const r = await capturePage(context, guard, site.url, viewport, {
      timeoutMs: 15_000,
      screenshot: true,
    });
    await context.close();

    expect(r.error).toBeNull();
    expect(r.status).toBe(200);
    expect(r.title).toBe("Demo Store – Home");
    expect(r.html).toContain("Rendered by JavaScript"); // rendered DOM, not raw HTML
    expect(r.screenshot!.subarray(1, 4).toString()).toBe("PNG");
    expect(
      r.console.some((c) => c.type === "error" && c.text.includes("intentional console error")),
    ).toBe(true);
    const hero = r.requests.find((q) => q.url.endsWith("/images/hero.jpg"));
    expect(hero).toMatchObject({ resourceType: "image", status: 200 });
    expect(hero!.decodedSize).toBe(300 * 1024);
    expect(
      r.requests.some((q) => q.url.endsWith("/assets/site.css") && q.resourceType === "stylesheet"),
    ).toBe(true);
    expect(r.renderedLinks).toContain(`${site.url}js-only`);
    expect(r.timings.loadMs).toBeGreaterThan(0);
  });

  it("uses mobile emulation below 768px", async () => {
    const viewport = { name: "mobile", width: 390, height: 844 };
    const { context, guard } = await newGuardedContext(session, {
      viewport,
      userAgent: "QACopilotTest",
      policy: policy(),
    });
    const r = await capturePage(context, guard, `${site.url}about`, viewport, {
      timeoutMs: 15_000,
      screenshot: true,
    });
    await context.close();
    expect(r.error).toBeNull();
    expect(r.timings.documentWidth).toBe(390);
  });

  it("blocks subresources on non-allowlisted private hosts and reports them", async () => {
    const viewport = { name: "desktop", width: 1280, height: 800 };
    const { context, guard } = await newGuardedContext(session, {
      viewport,
      userAgent: "QACopilotTest",
      policy: policy(),
    });
    const r = await capturePage(context, guard, `http://localhost:${internalPort}/page`, viewport, {
      timeoutMs: 15_000,
      screenshot: false,
    });
    await context.close();
    expect(r.status).toBe(200);
    expect(r.blockedRequests).toEqual([
      expect.objectContaining({ url: `http://127.0.0.1:${internalPort}/secret.png` }),
    ]);
    expect(r.requests.find((q) => q.url.includes("secret.png"))?.failureText).toBeTruthy();
  });

  it("reports navigation failures instead of throwing", async () => {
    const viewport = { name: "desktop", width: 1280, height: 800 };
    const { context, guard } = await newGuardedContext(session, {
      viewport,
      userAgent: "QACopilotTest",
      policy: { allowedPrivateHosts: [] },
    });
    const r = await capturePage(context, guard, site.url, viewport, {
      timeoutMs: 10_000,
      screenshot: true,
    });
    await context.close();
    expect(r.error).toMatch(/ERR_BLOCKED_BY_CLIENT/);
    expect(r.screenshot).toBeNull();
  });

  it("discovers JavaScript-rendered links", async () => {
    const viewport = { name: "desktop", width: 1280, height: 800 };
    const { context } = await newGuardedContext(session, {
      viewport,
      userAgent: "QACopilotTest",
      policy: policy(),
    });
    expect(await renderLinks(context, site.url, 10_000)).toContain(`${site.url}js-only`);
    await context.close();
  });
});
