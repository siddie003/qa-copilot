import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./redirect";
import { isPublicIp, validateWebsiteUrl, withDefaultScheme } from "./url";

const ok = (raw: string, allowedPrivateHosts: string[] = []) => {
  const r = validateWebsiteUrl(raw, { allowedPrivateHosts });
  if (!r.ok) throw new Error(`expected ${raw} to be accepted, got ${r.code}`);
  return r;
};
const code = (raw: string, allowedPrivateHosts: string[] = []) => {
  const r = validateWebsiteUrl(raw, { allowedPrivateHosts });
  return r.ok ? "OK" : r.code;
};

describe("withDefaultScheme", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["  example.com/path ", "https://example.com/path"],
    ["localhost:4100", "https://localhost:4100"],
    ["http://example.com", "http://example.com"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["mailto:a@b.com", "mailto:a@b.com"],
  ])("%s → %s", (input, expected) => {
    expect(withDefaultScheme(input)).toBe(expected);
  });
});

describe("validateWebsiteUrl: accepted", () => {
  it("normalizes a bare domain to https and drops the fragment", () => {
    expect(ok("Example.COM./about#team")).toMatchObject({
      url: "https://example.com./about",
      hostname: "example.com",
    });
  });
  it("keeps query strings and ports", () => {
    expect(ok("http://shop.example.co.uk:8080/p?id=1").url).toBe(
      "http://shop.example.co.uk:8080/p?id=1",
    );
  });
  it("accepts public IP literals", () => {
    expect(ok("http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });
  it("accepts internationalized domains (punycode)", () => {
    expect(ok("https://bücher.de").hostname).toBe("xn--bcher-kva.de");
  });
  it("accepts allowlisted private hosts (host:port)", () => {
    expect(ok("localhost:4100", ["localhost:4100"]).allowlisted).toBe(true);
  });
  it("accepts allowlisted hosts without a port entry", () => {
    expect(ok("http://staging.internal/", ["staging.internal"]).allowlisted).toBe(true);
  });
});

describe("validateWebsiteUrl: rejected", () => {
  it.each([
    ["", "INVALID_URL"],
    ["https://", "INVALID_URL"],
    ["ftp://example.com", "UNSUPPORTED_SCHEME"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
    ["file:///etc/passwd", "UNSUPPORTED_SCHEME"],
    ["data:text/html,<b>x</b>", "UNSUPPORTED_SCHEME"],
    ["https://user:pass@example.com", "CREDENTIALS_NOT_ALLOWED"],
    ["https://user@example.com", "CREDENTIALS_NOT_ALLOWED"],
    ["http://localhost", "LOCAL_HOSTNAME"],
    ["http://app.localhost:3000", "LOCAL_HOSTNAME"],
    ["http://printer.local", "LOCAL_HOSTNAME"],
    ["http://db.internal", "LOCAL_HOSTNAME"],
    ["http://intranet", "LOCAL_HOSTNAME"],
    ["http://127.0.0.1", "PRIVATE_ADDRESS"],
    ["http://127.1", "PRIVATE_ADDRESS"],
    ["http://0x7f.0.0.1", "PRIVATE_ADDRESS"],
    ["http://2130706433", "PRIVATE_ADDRESS"],
    ["http://0.0.0.0", "PRIVATE_ADDRESS"],
    ["http://10.1.2.3", "PRIVATE_ADDRESS"],
    ["http://172.16.0.1", "PRIVATE_ADDRESS"],
    ["http://192.168.1.1", "PRIVATE_ADDRESS"],
    ["http://100.64.0.1", "PRIVATE_ADDRESS"],
    ["http://169.254.169.254/latest/meta-data", "PRIVATE_ADDRESS"],
    ["http://224.0.0.1", "PRIVATE_ADDRESS"],
    ["http://[::1]", "PRIVATE_ADDRESS"],
    ["http://[::ffff:127.0.0.1]", "PRIVATE_ADDRESS"],
    ["http://[::ffff:10.0.0.1]", "PRIVATE_ADDRESS"],
    ["http://[fd00::1]", "PRIVATE_ADDRESS"],
    ["http://[fe80::1]", "PRIVATE_ADDRESS"],
    [`https://example.com/${"a".repeat(2100)}`, "URL_TOO_LONG"],
  ])("%s → %s", (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it("does not let an allowlisted port open other ports on the same host", () => {
    expect(code("http://localhost:5432", ["localhost:4100"])).toBe("LOCAL_HOSTNAME");
  });
});

describe("isPublicIp", () => {
  it("distinguishes public and private addresses", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("192.168.0.10")).toBe(false);
    expect(isPublicIp("not-an-ip")).toBe(false);
  });
});

describe("safeRedirectPath", () => {
  it.each([
    ["/projects/1?tab=a", "/projects/1?tab=a"],
    [null, "/dashboard"],
    ["https://evil.com", "/dashboard"],
    ["//evil.com", "/dashboard"],
    ["/\\evil.com", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["/ok\nSet-Cookie:x", "/dashboard"],
  ])("%s → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});
