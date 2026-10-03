import ipaddr from "ipaddr.js";

export type UrlRejectionCode =
  | "INVALID_URL"
  | "URL_TOO_LONG"
  | "UNSUPPORTED_SCHEME"
  | "CREDENTIALS_NOT_ALLOWED"
  | "PRIVATE_ADDRESS"
  | "LOCAL_HOSTNAME";

export type UrlValidationResult =
  | { ok: true; url: string; hostname: string; allowlisted: boolean }
  | { ok: false; code: UrlRejectionCode; message: string };

export interface UrlValidationOptions {
  /**
   * Explicitly authorized internal targets, as "host" or "host:port" (lowercase).
   * Everything else on loopback/private/link-local/reserved ranges is rejected.
   */
  allowedPrivateHosts?: string[];
}

export const MAX_URL_LENGTH = 2048;

// Suffixes that only resolve on private networks.
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet"];

const reject = (code: UrlRejectionCode, message: string): UrlValidationResult => ({
  ok: false,
  code,
  message,
});

/**
 * Adds https:// when the user typed a bare host ("example.com", "localhost:4100").
 * Inputs with another explicit scheme ("ftp://", "javascript:") are left alone so they get rejected.
 */
export function withDefaultScheme(raw: string): string {
  const input = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  // "mailto:x", "javascript:..." — a scheme not followed by a port number.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(input)) return input;
  return `https://${input}`;
}

/** Classifies an IP literal. Only globally routable unicast addresses are allowed. */
export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

function isAllowlisted(hostname: string, port: string, allowed: string[]): boolean {
  return allowed.includes(hostname) || allowed.includes(`${hostname}:${port}`);
}

/**
 * Validates a website URL supplied by a user before it is stored or scanned.
 * Static checks only (scheme, credentials, IP literals, local hostnames). DNS-based checks
 * that catch public names pointing at private addresses run at scan time in the crawler.
 */
export function validateWebsiteUrl(
  raw: string,
  opts: UrlValidationOptions = {},
): UrlValidationResult {
  const input = withDefaultScheme(raw);
  if (input.length > MAX_URL_LENGTH)
    return reject("URL_TOO_LONG", `URL must be at most ${MAX_URL_LENGTH} characters`);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject("INVALID_URL", "Enter a valid website URL, for example https://example.com");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:")
    return reject("UNSUPPORTED_SCHEME", "Only http and https URLs can be scanned");
  if (url.username || url.password)
    return reject("CREDENTIALS_NOT_ALLOWED", "URLs must not contain a username or password");

  // WHATWG URL parsing already normalizes IPv4 shorthand (0x7f.1, 2130706433) to dotted form.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return reject("INVALID_URL", "URL has no host name");
  const bareHost = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const allowlisted = isAllowlisted(hostname, port, opts.allowedPrivateHosts ?? []);

  if (!allowlisted) {
    if (ipaddr.isValid(bareHost)) {
      if (!isPublicIp(bareHost))
        return reject(
          "PRIVATE_ADDRESS",
          "Private, loopback and reserved IP addresses cannot be scanned",
        );
    } else if (
      hostname === "localhost" ||
      LOCAL_SUFFIXES.some((s) => hostname.endsWith(s)) ||
      !hostname.includes(".")
    ) {
      return reject("LOCAL_HOSTNAME", "Local network host names cannot be scanned");
    }
  }

  url.hash = "";
  return { ok: true, url: url.toString(), hostname, allowlisted };
}
