import http from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockedTargetError } from "./network";
import { assertPublicTarget, createGuardedDispatcher, type Resolver } from "./network";

const fakeDns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const addrs = table[host];
    if (!addrs) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

const dnsTable = fakeDns({
  "public.example": ["93.184.216.34"],
  "rebind.example": ["10.0.0.7"],
  "mixed.example": ["93.184.216.34", "127.0.0.1"],
  "v6local.example": ["fd00::1"],
  localhost: ["127.0.0.1"],
});
const policy = { allowedPrivateHosts: ["localhost:4100"] };

async function reason(url: string) {
  try {
    await assertPublicTarget(url, policy, dnsTable);
    return "OK";
  } catch (err) {
    return (err as BlockedTargetError).code;
  }
}

describe("assertPublicTarget", () => {
  it.each([
    ["https://public.example/page", "OK"],
    ["https://rebind.example/", "PRIVATE_ADDRESS"],
    ["https://mixed.example/", "PRIVATE_ADDRESS"],
    ["https://v6local.example/", "PRIVATE_ADDRESS"],
    ["https://missing.example/", "DNS_FAILURE"],
    ["http://127.0.0.1/", "PRIVATE_ADDRESS"],
    ["http://[::1]:8080/", "PRIVATE_ADDRESS"],
    ["http://169.254.169.254/latest", "PRIVATE_ADDRESS"],
    ["ftp://public.example/", "UNSUPPORTED_SCHEME"],
    ["http://localhost:4100/", "OK"],
    ["http://localhost:5432/", "PRIVATE_ADDRESS"],
  ])("%s → %s", async (url, expected) => {
    expect(await reason(url)).toBe(expected);
  });
});

describe("createGuardedDispatcher (real connections)", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("internal secret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses to connect when a public-looking name resolves to a private address", async () => {
    const dispatcher = createGuardedDispatcher(
      { allowedPrivateHosts: [] },
      { resolve: fakeDns({ "evil.example": ["127.0.0.1"] }) },
    );
    await expect(request(`http://evil.example:${port}/`, { dispatcher })).rejects.toThrow(
      /private address/,
    );
    await dispatcher.close();
  });

  it("connects to an allowlisted internal host", async () => {
    const dispatcher = createGuardedDispatcher(
      { allowedPrivateHosts: [`fixture.test:${port}`] },
      { resolve: fakeDns({ "fixture.test": ["127.0.0.1"] }) },
    );
    const res = await request(`http://fixture.test:${port}/`, { dispatcher });
    expect(await res.body.text()).toBe("internal secret");
    await dispatcher.close();
  });
});
