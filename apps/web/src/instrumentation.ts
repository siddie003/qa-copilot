/**
 * Runs once when the web server starts: reports risky production settings in the log (the
 * same checks are shown on the Settings page). Configuration errors are reported by readiness.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ConfigError, configWarnings, getConfig, getLogger } = await import("@qa/core");
  try {
    const log = getLogger().child({ component: "web" });
    for (const warning of configWarnings(getConfig()))
      log.warn({ warning }, "configuration warning");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }
}
