# Changelog

## [Unreleased]

### Phase 2: Database + project management (2026-10-03)
#### Added
- Full PostgreSQL schema (24 tables) for users, projects, references, content, scans, scanner
  runs, pages, captures, network requests, raw findings, evidence, issue tracks, issues, grounding
  checks, AI runs, reports and scan comparisons; initial migration and migration runner.
- Email + password authentication (Better Auth): sign-up, sign-in, sign-out, database sessions,
  rate limiting, protected pages and API routes, optional sign-up switch.
- Project API (`/api/v1/projects`) with search, pagination, owner isolation and soft delete.
- Project list, creation, overview and settings pages; delete with typed confirmation.
- `@qa/security` package: website URL validation against private/internal targets; safe redirects.
- Same-origin checks for state-changing API requests.
- Integration tests on a dedicated test database; HTTP smoke test script.
#### Changed
- `BETTER_AUTH_SECRET` is now required in every environment.
- Loading skeletons moved from the app-wide group to leaf routes (correct 404 status codes).

### Phase 1: Project foundation (2026-10-03)
#### Added
- npm-workspaces monorepo with `apps/web`, `apps/worker`, `packages/core`, `packages/db`.
- Environment configuration validated with zod; `.env.example`; `setup:env` secret generator.
- Structured JSON logging (pino) with secret redaction.
- Error model (`AppError`) and RFC 9457 problem+json API responses with request IDs.
- PostgreSQL connection pool, Drizzle client, real database health check, migration runner.
- `db:bootstrap` script to create the application role and databases.
- Next.js 16 application shell: responsive sidebar navigation, section pages with empty states,
  Settings page with live system status, loading/error/404 states, security headers.
- Health endpoints: `/api/v1/health`, `/api/v1/health/ready`; worker `/health` on port 3001.
- Vitest test suite (37 tests), ESLint, Prettier, TypeScript strict type checking.

### Phase 0: Architecture (2026-10-03)
#### Added
- Architecture and implementation plan (`docs/ARCHITECTURE.md`), project status tracking files.
