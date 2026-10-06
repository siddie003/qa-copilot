import { describe, expect, it } from "vitest";
import {
  AppError,
  notFound,
  publicErrorMessage,
  stripQueryParams,
  toProblem,
  validationError,
} from "./errors";

describe("toProblem", () => {
  it("exposes client-error messages and details", () => {
    const problem = toProblem(
      validationError("Website URL is invalid", [{ path: "url" }]),
      "req-1",
    );
    expect(problem).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      detail: "Website URL is invalid",
      errors: [{ path: "url" }],
      requestId: "req-1",
    });
  });

  it("hides messages of server errors", () => {
    const problem = toProblem(new AppError("EXTERNAL_SERVICE_ERROR", "upstream said: token abc"));
    expect(problem.status).toBe(502);
    expect(problem.detail).toBeUndefined();
  });

  it("maps unknown errors to an opaque 500", () => {
    const problem = toProblem(new Error("connection string postgres://u:p@h/db"));
    expect(problem).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(problem)).not.toContain("postgres://");
  });

  it("maps not found", () => {
    expect(toProblem(notFound("Project"))).toMatchObject({
      status: 404,
      detail: "Project not found",
    });
  });
});

// Phase 10: drizzle's DrizzleQueryError puts every bound parameter into its message.
class FakeQueryError extends Error {
  readonly query: string;
  readonly params: unknown[];
  constructor(query: string, params: unknown[], cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`);
    this.name = "DrizzleQueryError";
    this.query = query;
    this.params = params;
    this.cause = cause;
  }
}

const pgError = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
  code: "23505",
});
const queryError = new FakeQueryError(
  'select * from "session" where "token" = $1',
  ["SESSION-TOKEN-SECRET", "hash$argon2"],
  pgError,
);

describe("stripQueryParams", () => {
  it("removes bound parameters from messages and stacks, keeping the frames", () => {
    expect(stripQueryParams(queryError.message)).toBe(
      'Failed query: select * from "session" where "token" = $1\nparams: [redacted]',
    );
    const stack = stripQueryParams(queryError.stack!);
    expect(stack).not.toContain("SESSION-TOKEN-SECRET");
    expect(stack).toContain("params: [redacted]");
    expect(stack).toMatch(/\n {4}at /);
  });
  it("leaves other text alone", () => {
    expect(stripQueryParams("plain message")).toBe("plain message");
  });
});

describe("publicErrorMessage", () => {
  it("reduces database errors to the driver code and message (no SQL, no parameters)", () => {
    const text = publicErrorMessage(queryError);
    expect(text).toBe('Database error 23505: duplicate key value violates unique constraint "x"');
    expect(text).not.toContain("SESSION-TOKEN-SECRET");
    expect(text).not.toContain("select");
  });
  it("is one line and bounded", () => {
    expect(publicErrorMessage(new Error("a\n  b"))).toBe("a b");
    const long = publicErrorMessage(new Error("x".repeat(2000)), 100);
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
    expect(publicErrorMessage("boom")).toBe("boom");
  });
});
