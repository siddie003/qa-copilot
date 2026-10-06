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
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@qa/core", "@qa/db", "@qa/security", "@qa/storage"],
  serverExternalPackages: ["pino", "pg", "undici"],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
