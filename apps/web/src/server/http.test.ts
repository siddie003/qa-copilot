import { AppError } from "@qa/core";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { apiHandler, json, resolveRequestId } = await import("./http");

const req = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/v1/test", { headers });

describe("apiHandler", () => {
  it("passes through successful responses and sets x-request-id", async () => {
    const handler = apiHandler("test", async () => json({ ok: true }));
    const res = await handler(req({ "x-request-id": "abcdef12-req" }), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("abcdef12-req");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("converts AppErrors into problem+json", async () => {
    const handler = apiHandler("test", async () => {
      throw new AppError("VALIDATION_ERROR", "Website URL is invalid");
    });
    const res = await handler(req(), {});
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body).toMatchObject({ code: "VALIDATION_ERROR", detail: "Website URL is invalid" });
    expect(body.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("hides unexpected error details", async () => {
    const handler = apiHandler("test", async () => {
      throw new Error("password authentication failed for user qa");
    });
    const res = await handler(req(), {});
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("password authentication failed");
  });
});

describe("resolveRequestId", () => {
  it("rejects unsafe ids", () => {
    expect(resolveRequestId("<script>")).not.toBe("<script>");
    expect(resolveRequestId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
