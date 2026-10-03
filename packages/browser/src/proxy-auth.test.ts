import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Resolver } from "@qa/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturePage, launchBrowser, newGuardedContext } from "./index";

/** Local server that records every request it receives (path + selected headers). */
function recordingServer() {
  const seen: Array<{ path: string; authorization?: string; apiKey?: string; cookie?: string }> =
    [];
  const server = http.createServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
      cookie: req.headers.cookie,
    });
    if (req.url === "/protected") {
      if (req.headers.authorization !== `Basic ${Buffer.from("qa:s3cret").toString("base64")}`) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="qa"', "content-type": "text/html" });
        return res.end("<h1>login required</h1>");
      }
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<h1>members</h1><img src="http://third-party.test:${(server.address() as AddressInfo).port}/pixel.png">`,
      );
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<h1>ok</h1><img src="http://third-party.test:${(server.address() as AddressInfo).port}/pixel.png">`,
      );
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end("x");
  });
  return { server, seen };
}

describe("guard proxy and site authentication (real Chromium)", () => {
  const target = recordingServer();
  let port: number;
  beforeAll(async () => {
    await new Promise<void>((r) => target.server.listen(0, "127.0.0.1", r));
    port = (target.server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => target.server.close(() => r())));

  it("blocks a DNS rebinding attempt that passes the route-level check", async () => {
    // The route guard's resolver says "public"; the proxy's resolver (what a rebinding attacker
    // would switch to) says "loopback". Chromium never resolves DNS itself, so the proxy wins.
    const publicDns: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const rebindDns: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    const policy = { allowedPrivateHosts: [] };
    const session = await launchBrowser({ guard: { policy, resolve: rebindDns } });
    try {
      const viewport = { name: "desktop", width: 1280, height: 800 };
      const { context, guard } = await newGuardedContext(session, {
        viewport,
        userAgent: "QATest",
        policy,
        resolve: publicDns,
      });
      const before = target.seen.length;
      const r = await capturePage(context, guard, `http://rebind.test:${port}/page`, viewport, {
        timeoutMs: 10_000,
        screenshot: false,
        proxy: session.proxy,
      });
      await context.close();
      expect(r.error).toBeTruthy();
      expect(r.blockedRequests.some((b) => /127\.0\.0\.1/.test(b.reason))).toBe(true);
      expect(target.seen.length).toBe(before); // the internal server was never reached
    } finally {
      await session.close();
    }
  }, 60_000);

  it.each([
    ["basic", { type: "basic" as const, username: "qa", password: "s3cret" }],
    ["header", { type: "header" as const, name: "X-Api-Key", value: "key-123" }],
    ["cookies", { type: "cookies" as const, cookies: "sid=abc123" }],
  ])(
    "sends %s credentials to the scanned site only, never to third parties",
    async (_label, credentials) => {
      const dns: Resolver = async (host) =>
        host === "site.test" || host === "third-party.test"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [];
      const policy = { allowedPrivateHosts: [`site.test:${port}`, `third-party.test:${port}`] };
      const session = await launchBrowser({ guard: { policy, resolve: dns } });
      target.seen.length = 0;
      try {
        const viewport = { name: "desktop", width: 1280, height: 800 };
        const { context, guard } = await newGuardedContext(session, {
          viewport,
          userAgent: "QATest",
          policy,
          resolve: dns,
          auth: { siteUrl: `http://site.test:${port}/`, credentials },
        });
        // Browsers send Basic credentials in answer to a 401 challenge, so basic uses /protected.
        const path = credentials.type === "basic" ? "/protected" : "/page";
        const r = await capturePage(context, guard, `http://site.test:${port}${path}`, viewport, {
          timeoutMs: 10_000,
          screenshot: false,
          proxy: session.proxy,
        });
        await context.close();
        expect(r.error).toBeNull();
        expect(r.status).toBe(200);
        const pageReq = target.seen.filter((s) => s.path === path).at(-1)!;
        const pixelReq = target.seen.find((s) => s.path === "/pixel.png")!;
        expect(pixelReq).toBeDefined();
        if (credentials.type === "header") expect(pageReq.apiKey).toBe("key-123");
        if (credentials.type === "cookies") expect(pageReq.cookie).toContain("sid=abc123");
        if (credentials.type === "basic") expect(r.title).toBeNull(); // page has no <title>; status 200 proves login
        // The third-party request must never carry any credential.
        expect(pixelReq.apiKey).toBeUndefined();
        expect(pixelReq.cookie).toBeUndefined();
        expect(pixelReq.authorization).toBeUndefined();
      } finally {
        await session.close();
      }
    },
    60_000,
  );
});
