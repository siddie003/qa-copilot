import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect for signed-out visitors (cookie presence only, no database lookup).
 * The real session check happens in the app layout and in every API handler.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/projects/:path*",
    "/scans/:path*",
    "/issues/:path*",
    "/reports/:path*",
    "/settings/:path*",
  ],
};
