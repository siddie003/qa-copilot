import { z } from "zod";

// Headers a custom auth header must never replace (they would break or hijack requests).
const FORBIDDEN_HEADERS = new Set([
  "host",
  "cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "proxy-authorization",
  "origin",
  "referer",
  "user-agent",
]);

const cookiePair = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;,\s]*$/;

/** Control characters (tab excepted) would split or corrupt an HTTP request (header injection). */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 32 && code !== 9) || code === 127) return true;
  }
  return false;
}

const noControlChars = (field: string) =>
  [
    (v: string) => !hasControlChars(v),
    `the ${field} must not contain line breaks or control characters`,
  ] as const;

/**
 * Credentials for scanning a login-protected site. They are only ever sent to the target site
 * (same host, www-aware), never to third-party resources.
 */
export const scanAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1, "username is required")
      .max(256)
      .refine(...noControlChars("username"))
      .refine((u) => !u.includes(":"), "the username must not contain a colon (HTTP Basic)"),
    password: z
      .string()
      .min(1, "password is required")
      .max(1024)
      .refine(...noControlChars("password")),
  }),
  z.object({
    type: z.literal("header"),
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, "use letters, digits and dashes")
      .refine((n) => !FORBIDDEN_HEADERS.has(n.toLowerCase()), "this header cannot be used"),
    value: z
      .string()
      .min(1, "value is required")
      .max(4096)
      .refine(...noControlChars("value")),
  }),
  z.object({
    type: z.literal("cookies"),
    cookies: z
      .string()
      .trim()
      .min(1, "enter at least one cookie")
      .max(8192)
      .refine(
        (s) =>
          parseCookieString(s).length > 0 &&
          s.split(";").every((p) => !p.trim() || cookiePair.test(p.trim())),
        'use the format "name=value; name2=value2"',
      ),
  }),
]);
export type ScanAuth = z.infer<typeof scanAuthSchema>;

export function parseCookieString(s: string): Array<{ name: string; value: string }> {
  return s
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf("=");
      return { name: p.slice(0, i), value: p.slice(i + 1) };
    })
    .filter((c) => c.name);
}

/** Non-secret description, safe to store in clear text, log and show in the UI. */
export interface ScanAuthSummary {
  type: ScanAuth["type"];
  username?: string;
  headerName?: string;
  cookieNames?: string[];
}

export function summarizeScanAuth(a: ScanAuth): ScanAuthSummary {
  if (a.type === "basic") return { type: "basic", username: a.username };
  if (a.type === "header") return { type: "header", headerName: a.name };
  return { type: "cookies", cookieNames: parseCookieString(a.cookies).map((c) => c.name) };
}

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** True when `url` is on the scanned site (same host, www-aware, same port). */
export function isOnSite(url: string, siteUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(siteUrl);
    return stripWww(a.hostname) === stripWww(b.hostname) && a.port === b.port;
  } catch {
    return false;
  }
}

/** HTTP headers carrying the credentials, only for URLs on the scanned site. */
export function authHeadersFor(
  auth: ScanAuth | null,
  siteUrl: string,
  url: string,
): Record<string, string> {
  if (!auth || !isOnSite(url, siteUrl)) return {};
  if (auth.type === "basic")
    return {
      authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
    };
  if (auth.type === "header") return { [auth.name.toLowerCase()]: auth.value };
  return {
    cookie: parseCookieString(auth.cookies)
      .map((c) => `${c.name}=${c.value}`)
      .join("; "),
  };
}
