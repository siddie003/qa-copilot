import { describe, expect, it } from "vitest";
import { AppError, notFound, toProblem, validationError } from "./errors";

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
