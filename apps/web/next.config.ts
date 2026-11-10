import path from "node:path";
import type { NextConfig } from "next";

// `npm run -w @qa/web` executes with cwd = apps/web, so the monorepo root is two levels up.
const repoRoot = path.resolve(process.cwd(), "../..");

// Headers for every response. Pages additionally get the nonce-based script CSP and, on HTTPS
// deployments, HSTS from proxy.ts (both need per-request or runtime values). Browsers enforce
// every CSP header they receive, so this static policy and the page policy combine.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];
const staticCsp = {
  key: "Content-Security-Policy",
  value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
// Stored files (screenshots, snapshots, report downloads) set a stricter policy of their own
// (`default-src 'none'; sandbox`). A header from this config replaces a route's header of the
// same name, so the static policy is not applied to those routes (found in Phase 16).
const OWN_CSP_ROUTES = "api/v1/artifacts/|api/v1/reports/[^/]+/download";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@qa/core", "@qa/db", "@qa/security", "@qa/storage"],
  serverExternalPackages: ["pino", "pg", "undici"],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: `/:path((?!${OWN_CSP_ROUTES}).*)`, headers: [staticCsp] },
    ];
  },
};

export default nextConfig;
