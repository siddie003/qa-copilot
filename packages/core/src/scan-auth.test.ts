import { describe, expect, it } from "vitest";
import { authHeadersFor, isOnSite, scanAuthSchema, summarizeScanAuth } from "./scan-auth";

const site = "https://example.com/";

describe("scanAuthSchema", () => {
  it("accepts the three credential types", () => {
    expect(scanAuthSchema.safeParse({ type: "basic", username: "u", password: "p" }).success).toBe(
      true,
    );
    expect(
      scanAuthSchema.safeParse({ type: "header", name: "X-Api-Key", value: "abc" }).success,
    ).toBe(true);
    expect(
      scanAuthSchema.safeParse({ type: "cookies", cookies: "sid=abc; theme=dark" }).success,
    ).toBe(true);
  });
  it.each([
    { type: "header", name: "Host", value: "evil" },
    { type: "header", name: "Cookie", value: "x=1" },
    { type: "header", name: "Bad Header", value: "x" },
    { type: "cookies", cookies: "no-equals-sign" },
    { type: "basic", username: "", password: "p" },
  ])("rejects %o", (input) => {
    expect(scanAuthSchema.safeParse(input).success).toBe(false);
  });
});

describe("authHeadersFor", () => {
  it("sends credentials only to the scanned site (www-aware)", () => {
    const auth = { type: "basic" as const, username: "qa", password: "pw" };
    expect(authHeadersFor(auth, site, "https://www.example.com/page")).toEqual({
      authorization: `Basic ${Buffer.from("qa:pw").toString("base64")}`,
    });
    expect(authHeadersFor(auth, site, "https://cdn.other.com/lib.js")).toEqual({});
    expect(authHeadersFor(auth, site, "https://example.com.evil.com/")).toEqual({});
    expect(authHeadersFor(null, site, site)).toEqual({});
  });
  it("builds header and cookie credentials", () => {
    expect(authHeadersFor({ type: "header", name: "X-Api-Key", value: "k" }, site, site)).toEqual({
      "x-api-key": "k",
    });
    expect(authHeadersFor({ type: "cookies", cookies: "a=1; b=2" }, site, site)).toEqual({
      cookie: "a=1; b=2",
    });
  });
  it("summaries contain no secrets", () => {
    expect(summarizeScanAuth({ type: "basic", username: "qa", password: "pw" })).toEqual({
      type: "basic",
      username: "qa",
    });
    expect(
      JSON.stringify(summarizeScanAuth({ type: "cookies", cookies: "sid=SECRET" })),
    ).not.toContain("SECRET");
    expect(isOnSite("http://localhost:4100/x", "http://localhost:4101/")).toBe(false);
  });
});
