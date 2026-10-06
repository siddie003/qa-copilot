import { describe, expect, it } from "vitest";
import { ConfigError, configWarnings, describeConfig, parseConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://qa:secret-pw@localhost:5432/qa_copilot",
  BETTER_AUTH_SECRET: "auth-secret-value-that-is-long-enough-123",
};

function issuesOf(env: Record<string, string>) {
  try {
    parseConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).issues;
  }
  throw new Error("expected ConfigError");
}

describe("parseConfig", () => {
  it("applies defaults for optional settings", () => {
    const cfg = parseConfig(base);
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.AI_PROVIDER).toBe("none");
    expect(cfg.SCAN_MAX_PAGES).toBe(25);
    expect(cfg.SCAN_RESPECT_ROBOTS).toBe(true);
    expect(cfg.SCAN_ALLOWED_PRIVATE_HOSTS).toEqual([]);
    expect(cfg.storageDirAbsolute).toMatch(/storage$/);
  });

  it("reports a missing DATABASE_URL by name", () => {
    expect(issuesOf({})).toContainEqual({ variable: "DATABASE_URL", message: "is required" });
  });

  it("treats empty strings as unset", () => {
    expect(issuesOf({ DATABASE_URL: "" })).toContainEqual({
      variable: "DATABASE_URL",
      message: "is required",
    });
  });

  it("rejects non-postgres database URLs", () => {
    const issues = issuesOf({ DATABASE_URL: "mysql://localhost/db" });
    expect(issues.map((i) => i.variable)).toContain("DATABASE_URL");
  });

  it("never includes secret values in the error message", () => {
    try {
      parseConfig({ ...base, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-very-secret" });
    } catch (err) {
      expect((err as Error).message).not.toContain("secret-pw");
      expect((err as Error).message).not.toContain("sk-very-secret");
      expect((err as ConfigError).issues.map((i) => i.variable)).toEqual(["AI_MODEL"]);
      return;
    }
    throw new Error("expected ConfigError");
  });

  it("requires the auth secret in every environment", () => {
    const vars = issuesOf({ DATABASE_URL: base.DATABASE_URL }).map((i) => i.variable);
    expect(vars).toEqual(["BETTER_AUTH_SECRET"]);
  });

  it("rejects a short auth secret", () => {
    const vars = issuesOf({ ...base, BETTER_AUTH_SECRET: "short" }).map((i) => i.variable);
    expect(vars).toEqual(["BETTER_AUTH_SECRET"]);
  });

  it("requires the encryption key in production", () => {
    const vars = issuesOf({ ...base, NODE_ENV: "production" }).map((i) => i.variable);
    expect(vars).toEqual(["ENCRYPTION_KEY"]);
  });

  it("requires the provider key when an AI provider is selected", () => {
    const vars = issuesOf({ ...base, AI_PROVIDER: "anthropic", AI_MODEL: "m" }).map(
      (i) => i.variable,
    );
    expect(vars).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("parses the private-host allowlist", () => {
    const cfg = parseConfig({
      ...base,
      SCAN_ALLOWED_PRIVATE_HOSTS: " Localhost:4100 , ,127.0.0.1:8080",
    });
    expect(cfg.SCAN_ALLOWED_PRIVATE_HOSTS).toEqual(["localhost:4100", "127.0.0.1:8080"]);
  });

  it("rejects malformed encryption keys and out-of-range numbers", () => {
    const vars = issuesOf({ ...base, ENCRYPTION_KEY: "abc", SCAN_MAX_PAGES: "0" }).map(
      (i) => i.variable,
    );
    expect(vars).toEqual(expect.arrayContaining(["ENCRYPTION_KEY", "SCAN_MAX_PAGES"]));
  });
});

describe("describeConfig", () => {
  it("contains no secret values", () => {
    const cfg = parseConfig({
      ...base,
      BETTER_AUTH_SECRET: "x".repeat(40),
      FIGMA_ACCESS_TOKEN: "figd_secret_token",
    });
    const text = JSON.stringify(describeConfig(cfg));
    expect(text).not.toContain("secret-pw");
    expect(text).not.toContain("figd_secret_token");
    expect(text).not.toContain("x".repeat(40));
    expect(text).not.toContain(base.BETTER_AUTH_SECRET);
    expect(describeConfig(cfg).figmaConfigured).toBe(true);
  });
});

describe("Phase 10 settings", () => {
  it("defaults to safe values", () => {
    const cfg = parseConfig(base);
    expect(cfg.TRUSTED_PROXIES).toEqual([]);
    expect(cfg.CLIENT_IP_HEADER).toBe("x-forwarded-for");
    expect(cfg.RATE_LIMIT_ENABLED).toBe(true);
    expect(cfg.WORKER_HEALTH_HOST).toBe("127.0.0.1");
    expect(cfg.WORKER_SHUTDOWN_GRACE_MS).toBe(20_000);
  });

  it("parses trusted proxies and rejects anything that is not an IP or CIDR range", () => {
    const cfg = parseConfig({
      ...base,
      TRUSTED_PROXIES: " 10.0.0.1, 172.16.0.0/12 ,fd00::/8 ",
      CLIENT_IP_HEADER: "X-Real-IP",
    });
    expect(cfg.TRUSTED_PROXIES).toEqual(["10.0.0.1", "172.16.0.0/12", "fd00::/8"]);
    expect(cfg.CLIENT_IP_HEADER).toBe("x-real-ip");
    expect(issuesOf({ ...base, TRUSTED_PROXIES: "proxy.internal" }).map((i) => i.variable)).toEqual(
      ["TRUSTED_PROXIES.0"],
    );
    expect(issuesOf({ ...base, CLIENT_IP_HEADER: "x forwarded" }).map((i) => i.variable)).toEqual([
      "CLIENT_IP_HEADER",
    ]);
  });

  it("warns about risky production settings only in production", () => {
    expect(configWarnings(parseConfig(base))).toEqual([]);
    const prod = {
      ...base,
      NODE_ENV: "production",
      ENCRYPTION_KEY: "a".repeat(64),
    };
    const risky = configWarnings(
      parseConfig({
        ...prod,
        APP_URL: "http://qa.example.com",
        SCAN_ALLOWED_PRIVATE_HOSTS: "localhost:4100",
        RATE_LIMIT_ENABLED: "false",
      }),
    );
    expect(risky.join("\n")).toMatch(/APP_URL is not HTTPS/);
    expect(risky.join("\n")).toMatch(/localhost:4100/);
    expect(risky.join("\n")).toMatch(/AUTH_ALLOW_SIGNUP=true/);
    expect(risky.join("\n")).toMatch(/RATE_LIMIT_ENABLED=false/);
    expect(risky.join("\n")).toMatch(/TRUSTED_PROXIES is empty/);
    const hardened = configWarnings(
      parseConfig({
        ...prod,
        APP_URL: "https://qa.example.com",
        AUTH_ALLOW_SIGNUP: "false",
        TRUSTED_PROXIES: "10.0.0.2",
      }),
    );
    expect(hardened).toEqual([]);
  });
});
