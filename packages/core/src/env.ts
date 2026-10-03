import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotEnvFile } from "dotenv";

let loaded = false;

/**
 * Walks up from `start` to find the monorepo root (the package.json that declares workspaces).
 * Both apps load the single root `.env` so configuration lives in one place.
 */
export function findRepoRoot(start: string = process.cwd()): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // Unreadable package.json: keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Loads `<repoRoot>/.env` once. Variables already present in the process environment always win. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const root = findRepoRoot();
  if (!root) return;
  const file = path.join(root, ".env");
  if (existsSync(file)) loadDotEnvFile({ path: file, quiet: true });
}
