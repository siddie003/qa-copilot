# Implementation Notes

## Key architectural decisions
- TypeScript monorepo (npm workspaces): `apps/web` (Next.js UI + `/api/v1`), `apps/worker` (scan
  pipeline), `packages/*`. Workspace packages export TS source (`"exports": "./src/index.ts"`);
  Next.js compiles them via `transpilePackages`, the worker runs them via `tsx`.
- One root `.env`, loaded by `@qa/core` `loadEnv()` (walks up to the package.json with
  `workspaces`). Process env always wins over the file. `next start` forces NODE_ENV=production.
- `getConfig()` throws `ConfigError` listing variable names only. Web readiness reports invalid
  config as `not_ready` instead of crashing; the worker exits at startup.
- Logs: pino JSON to stdout, redaction list in `packages/core/src/redact.ts`. `LOG_LEVEL` is read
  directly so logging works even with invalid config. Tests run with `LOG_LEVEL=silent`.
- API errors: throw `AppError(code, message)` from handlers wrapped in `apiHandler()`; 5xx
  messages are never exposed to clients.
- `pg` and `pino` are `serverExternalPackages` in Next.js; the DB pool is cached on `globalThis`
  to survive dev hot reloads.
- Readiness hides filesystem paths and invalid variable names unless `includeDetails`
  (non-production API, Settings page).
- Full nonce-based CSP deferred to Phase 10; `frame-ancestors 'none'` and other safe headers now.
- Versions: Next 16.3, React 19.3, Tailwind 4.3, TypeScript 6.0 (TS 7 not yet supported by
  typescript-eslint), ESLint 9 (eslint-plugin-react lacks ESLint 10 support), Vitest 5, zod 4,
  drizzle-orm 0.45, pino 10.
- PostgreSQL-backed queue (pg-boss) planned for Phase 4; no Redis.
- Live scan status: `scanner_run` rows, then Postgres NOTIFY, then SSE (Phase 4).
- Scanners deterministic and evidence-first; AI only groups/explains; grounding deterministic.
- `issue_track` (cross-scan status) + `issue` (per-scan occurrence) for scan comparison.

## Environment facts
- PostgreSQL 18 binaries: `C:\Program Files\PostgreSQL\18\bin` (not on PATH). Service `postgresql-x64-18`.
- No Docker, no Redis, no pnpm. Windows 11, Node 22.16.
- Project folder: `C:\Users\Siddharth\Downloads\qa-copilot`.

## Unfinished tasks
- User to run `npm run db:bootstrap`, then verify `npm run db:check` and readiness = ready.

## Known bugs
- None known.

## Commands to resume
```bash
git status && git log --oneline
npm install
npm run typecheck && npm run lint && npm test
npm run db:check
npm run dev
```
Read `PROJECT_STATUS.md`, this file and `docs/ARCHITECTURE.md` first.
