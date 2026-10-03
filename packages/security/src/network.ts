import dns from "node:dns";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import { isPublicIp } from "./url";

/** Which internal hosts an operator explicitly authorized ("host" or "host:port", lowercase). */
export interface TargetPolicy {
  allowedPrivateHosts: string[];
}

export type BlockReason = "UNSUPPORTED_SCHEME" | "PRIVATE_ADDRESS" | "DNS_FAILURE";

export class BlockedTargetError extends Error {
  readonly code: BlockReason;
  readonly host: string;
  constructor(code: BlockReason, host: string, message: string) {
    super(message);
    this.name = "BlockedTargetError";
    this.code = code;
    this.host = host;
  }
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

function defaultPort(url: URL) {
  return url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
}

export function isAllowlisted(url: URL, policy: TargetPolicy): boolean {
  const host = url.hostname.toLowerCase();
  return (
    policy.allowedPrivateHosts.includes(host) ||
    policy.allowedPrivateHosts.includes(`${host}:${defaultPort(url)}`)
  );
}

/** Hostnames (without port) that appear in the allowlist; used at connect time. */
function allowlistedHostnames(policy: TargetPolicy): Set<string> {
  return new Set(policy.allowedPrivateHosts.map((h) => bare(h.replace(/:\d+$/, ""))));
}

/**
 * Resolves the URL's host and rejects it unless every address is publicly routable (or the
 * host:port is explicitly allowlisted). Call before every outgoing request and redirect hop.
 */
export async function assertPublicTarget(
  rawUrl: string,
  policy: TargetPolicy,
  resolve: Resolver = systemResolver,
): Promise<void> {
  const url = new URL(rawUrl);
  const host = bare(url.hostname);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedTargetError(
      "UNSUPPORTED_SCHEME",
      host,
      `Scheme ${url.protocol} is not allowed`,
    );
  if (isAllowlisted(url, policy)) return;

  if (ipaddr.isValid(host)) {
    if (!isPublicIp(host))
      throw new BlockedTargetError(
        "PRIVATE_ADDRESS",
        host,
        `${host} is a private or reserved address`,
      );
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new BlockedTargetError(
      "DNS_FAILURE",
      host,
      `Host ${host} could not be resolved (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  if (addresses.length === 0)
    throw new BlockedTargetError("DNS_FAILURE", host, `Host ${host} has no addresses`);
  const blocked = addresses.find((a) => !isPublicIp(a.address));
  if (blocked)
    throw new BlockedTargetError(
      "PRIVATE_ADDRESS",
      host,
      `${host} resolves to a private or reserved address (${blocked.address})`,
    );
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * An undici dispatcher whose DNS lookup refuses private addresses at connect time. This pins the
 * check to the address actually connected to, which defeats DNS rebinding between the
 * pre-request check and the connection.
 */
export function createGuardedDispatcher(
  policy: TargetPolicy,
  opts: { resolve?: Resolver; connectTimeoutMs?: number } = {},
): Agent {
  const resolve = opts.resolve ?? systemResolver;
  const trusted = allowlistedHostnames(policy);
  const lookup = (hostname: string, options: { all?: boolean } | number, cb: LookupCallback) => {
    const all = typeof options === "object" && options?.all;
    resolve(hostname)
      .then((addresses) => {
        const host = bare(hostname);
        if (!trusted.has(host)) {
          const bad = addresses.find((a) => !isPublicIp(a.address));
          if (bad) {
            const err = Object.assign(
              new Error(`Blocked connection to private address ${bad.address}`),
              {
                code: "EBLOCKED_PRIVATE",
              },
            );
            return cb(err, "");
          }
        }
        if (all) return cb(null, addresses);
        const first = addresses[0]!;
        return cb(null, first.address, first.family);
      })
      .catch((err: NodeJS.ErrnoException) => cb(err, ""));
  };
  return new Agent({
    connect: { lookup: lookup as never, timeout: opts.connectTimeoutMs ?? 10_000 },
    maxRedirections: 0,
  } as ConstructorParameters<typeof Agent>[0]);
}
