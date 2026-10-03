# Implementation Notes

## Key architectural decisions (Phase 0, pending approval)
- TypeScript monorepo (npm workspaces): `apps/web` (Next.js UI + `/api/v1`), `apps/worker` (scan pipeline), `packages/*` (core, db, security, crawler, browser, scanners, reference, ai, reports, storage).
- PostgreSQL + Drizzle migrations; **pg-boss** queue in Postgres (no Redis on this machine).
- Live scan status: `scanner_run` rows → Postgres NOTIFY → SSE; polling fallback. Never simulated.
- Scanners are deterministic and evidence-first; AI only groups/explains; grounding validator is deterministic; AI failure ⇒ deterministic issues.
- `issue_track` (cross-scan, holds developer status, keyed by fingerprint) + `issue` (per-scan occurrence) enable New/Resolved/Persistent/Reopened.
- "Resolved" in comparisons requires the scanner to have completed and the page to have been re-crawled; otherwise "Not rechecked".
- Demo data isolated with `isDemo` flag + separate workspace; fixture site doubles as test target.

## Environment facts
- PostgreSQL 18 binaries: `C:\Program Files\PostgreSQL\18\bin` (not on PATH). Service `postgresql-x64-18`.
- No Docker, no Redis, no pnpm.

## Unfinished tasks
- Everything after Phase 0.

## Known bugs
- None (no code yet).

## Commands to resume
- Read `PROJECT_STATUS.md`, this file, `docs/ARCHITECTURE.md`, then `git status` (once the repo exists).
