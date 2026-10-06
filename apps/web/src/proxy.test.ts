import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : undefined,
  });

afterEach(() => vi.unstubAllEnvs());

describe("proxy (sign-in redirect + CSP)", () => {
  it("redirects signed-out visitors of app pages to the login page", () => {
    const res = proxy(req("/projects/abc?tab=x"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/projects/abc?tab=x");
  });

  it("does not treat look-alike paths as app pages", () => {
    expect(proxy(req("/projectsx")).headers.get("location")).toBeNull();
  });

  it("sends a per-request nonce CSP on pages, also to signed-out visitors of the login page", () => {
    const a = proxy(req("/login"));
    const b = proxy(req("/dashboard", "better-auth.session_token=abc"));
    const cspA = a.headers.get("content-security-policy")!;
    const cspB = b.headers.get("content-security-policy")!;
    const nonce = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce(cspA)).toBeTruthy();
    expect(nonce(cspA)).not.toBe(nonce(cspB));
    // The nonce reaches the renderer through the request headers.
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce(cspA));
    expect(a.headers.get("strict-transport-security")).toBeNull();
  });

  it("adds HSTS when the app is served over HTTPS", () => {
    vi.stubEnv("APP_URL", "https://qa.example.com");
    const res = proxy(req("/login"));
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
    expect(res.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
  });
});
