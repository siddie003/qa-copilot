import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, errorFields } from "./logger";
import { maskUrlCredentials } from "./redact";

// The test runner silences logs globally; these tests need real output.
const previousLevel = process.env.LOG_LEVEL;
beforeAll(() => {
  process.env.LOG_LEVEL = "info";
});
afterAll(() => {
  process.env.LOG_LEVEL = previousLevel;
});

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { stream, lines };
}

describe("logger", () => {
  it("writes structured JSON with bindings", () => {
    const { stream, lines } = capture();
    createLogger({ scanId: "scan_1" }, stream).info({ scanner: "seo", findingCount: 3 }, "done");
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: "info",
      service: "qa-copilot",
      scanId: "scan_1",
      scanner: "seo",
      findingCount: 3,
      msg: "done",
    });
    expect(typeof entry.time).toBe("string");
  });

  it("redacts secrets", () => {
    const { stream, lines } = capture();
    createLogger({}, stream).info(
      {
        password: "hunter2",
        provider: { apiKey: "sk-123" },
        headers: { authorization: "Bearer abc", cookie: "sid=1" },
        DATABASE_URL: "postgres://u:p@h/db",
      },
      "x",
    );
    const text = lines.join("");
    for (const secret of ["hunter2", "sk-123", "Bearer abc", "sid=1", "postgres://u:p@h/db"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[REDACTED]");
  });
});

describe("errorFields", () => {
  it("extracts name, message and code", () => {
    const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    expect(errorFields(err)).toMatchObject({
      errName: "Error",
      errMessage: "refused",
      errCode: "ECONNREFUSED",
    });
  });
  it("handles non-errors", () => {
    expect(errorFields("boom")).toEqual({ errName: "NonError", errMessage: "boom" });
  });
});

describe("maskUrlCredentials", () => {
  it("masks username and password", () => {
    expect(maskUrlCredentials("postgres://qa:pw@localhost:5432/db")).toBe(
      "postgres://***:***@localhost:5432/db",
    );
  });
  it("handles garbage", () => {
    expect(maskUrlCredentials("not a url")).toBe("[unparseable url]");
  });
});

describe("errorFields (query errors)", () => {
  it("never logs bound query parameters but keeps the database cause", () => {
    const cause = Object.assign(new Error("connection terminated"), { code: "57P01" });
    const err = new Error('Failed query: select 1 where "token" = $1\nparams: TOKEN-VALUE-123', {
      cause,
    });
    const fields = errorFields(err);
    expect(JSON.stringify(fields)).not.toContain("TOKEN-VALUE-123");
    expect(fields).toMatchObject({ errCode: "57P01", errCause: "connection terminated" });
  });
});
