import path from "node:path";
import type { NextConfig } from "next";

// `npm run -w @qa/web` executes with cwd = apps/web, so the monorepo root is two levels up.
const repoRoot = path.resolve(process.cwd(), "../..");

// A full nonce-based script CSP is added during production hardening (Phase 10).
// These headers are safe to apply now without breaking Next.js inline bootstrapping.
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
