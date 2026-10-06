import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, createNonce } from "./csp";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));

describe("Content-Security-Policy", () => {
  it("allows scripts only with the request's nonce (no inline or eval in production)", () => {
    const csp = buildContentSecurityPolicy({ nonce: "abc123==" });
    const scripts = directive(csp, "script-src")!;
    expect(scripts).toContain("'nonce-abc123=='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(directive(csp, "upgrade-insecure-requests")).toBeUndefined();
  });

  it("adds eval/WebSocket only for the dev server and upgrades requests on HTTPS", () => {
    const dev = buildContentSecurityPolicy({ nonce: "n", dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    const https = buildContentSecurityPolicy({ nonce: "n", https: true });
    expect(directive(https, "upgrade-insecure-requests")).toBe("upgrade-insecure-requests");
  });

  it("creates unpredictable base64 nonces", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => createNonce()));
    expect(nonces.size).toBe(200);
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});
