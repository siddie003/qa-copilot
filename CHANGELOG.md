# Changelog

## [Unreleased]

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
