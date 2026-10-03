/** Replaces credentials in a URL with "***" so it can be logged or displayed safely. */
export function maskUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return "[unparseable url]";
  }
}

const SECRET_KEYS = [
  "password",
  "token",
  "apiKey",
  "secret",
  "authorization",
  "cookie",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "FIGMA_ACCESS_TOKEN",
  "BETTER_AUTH_SECRET",
  "ENCRYPTION_KEY",
];

/** Paths redacted by the logger (top level and one level deep), plus HTTP header locations. */
export const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
];
