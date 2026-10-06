import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { buildContentSecurityPolicy, createNonce, STRICT_TRANSPORT_SECURITY } from "@/lib/csp";

/** Pages that need a session (the app layout and every API handler check it for real). */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/projects",
  "/scans",
  "/issues",
  "/reports",
  "/settings",
];

const isProtected = (pathname: string) =>
  PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Runs before every page request:
 * 1. Optimistic redirect for signed-out visitors of app pages (cookie presence only, no database
 *    lookup; the real session check happens in the app layout and in every API handler).
 * 2. A per-request nonce and the page's Content-Security-Policy. Next.js reads the nonce from the
 *    request's CSP header and adds it to the scripts it renders.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isProtected(pathname) && !getSessionCookie(request)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  const appUrl = process.env.APP_URL;
  const https = appUrl ? appUrl.startsWith("https://") : request.nextUrl.protocol === "https:";
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === "development",
    https,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  if (https) response.headers.set("strict-transport-security", STRICT_TRANSPORT_SECURITY);
  return response;
}

export const config = {
  // Every page; not API routes (they send their own restrictive headers), build assets or icons.
  matcher: ["/((?!api/|_next/static|_next/image|favicon\\.ico|icon|apple-icon).*)"],
};
