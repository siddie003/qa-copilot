/**
 * Content Security Policy for the application's pages. Scripts run only with the per-request
 * nonce (Next.js adds it to its own scripts; 'strict-dynamic' lets those load their chunks), so
 * injected markup cannot execute script even if escaping failed somewhere. Styles allow inline
 * attributes (React `style` props such as color swatches); nothing loads from other origins.
 */
export function buildContentSecurityPolicy(opts: {
  nonce: string;
  /** Development server: React needs eval for debugging; HMR uses a WebSocket. */
  dev?: boolean;
  https?: boolean;
}): string {
  const directives: string[][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${opts.nonce}'`,
      "'strict-dynamic'",
      ...(opts.dev ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'", "data:"],
    ["connect-src", "'self'", ...(opts.dev ? ["ws:", "wss:"] : [])],
    ["frame-src", "'none'"],
    ["worker-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ...(opts.https ? [["upgrade-insecure-requests"]] : []),
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** 128-bit random nonce, base64 (Web Crypto: works in every runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** HSTS for HTTPS deployments (one year, subdomains included). */
export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";
