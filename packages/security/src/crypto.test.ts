import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

const key = randomBytes(32).toString("hex");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and never contains the plaintext", () => {
    const enc = encryptSecret('{"password":"hunter2"}', key, "project-1");
    expect(enc).not.toContain("hunter2");
    expect(decryptSecret(enc, key, "project-1")).toBe('{"password":"hunter2"}');
  });
  it("uses a fresh IV each time", () => {
    expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key));
  });
  it("rejects a wrong key, wrong context or tampered data", () => {
    const enc = encryptSecret("secret", key, "project-1");
    expect(() => decryptSecret(enc, randomBytes(32).toString("hex"), "project-1")).toThrow();
    expect(() => decryptSecret(enc, key, "project-2")).toThrow();
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "project-1")).toThrow();
  });
});
