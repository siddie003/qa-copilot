/**
 * Returns `next` only if it is a same-site relative path; otherwise the fallback.
 * Prevents open redirects through ?next= on the login page.
 */
export function safeRedirectPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  try {
    // Resolving against a dummy origin must not change the origin.
    const resolved = new URL(next, "http://placeholder.invalid");
    if (resolved.origin !== "http://placeholder.invalid") return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}
