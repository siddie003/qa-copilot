# QA Copilot

AI-powered website QA, design and brand compliance platform. You provide a design reference
(Figma or brand guidelines), approved content and a website URL; QA Copilot crawls the site,
runs evidence-based QA scanners, and turns the findings into developer-ready issues and reports.

> **Status:** Phase 2 (database, authentication, project management). See [PROJECT_STATUS.md](PROJECT_STATUS.md) and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A full README (Docker, deployment, scanners, AI
> configuration) is completed in Phase 10.

## Requirements

- Node.js 22.12+ (npm 10+)
- PostgreSQL 15+ running locally (developed against 18)

## Local setup

```bash
npm install
npm run setup:env        # creates .env with generated local secrets (never overwrites)
npm run db:bootstrap     # creates the qa_copilot role + databases; psql asks for your postgres password
npm run db:check         # verifies the app can connect
npm run db:migrate       # creates/updates all tables (run after every pull)
```

Then open http://localhost:3000, choose **Create one** on the sign-in page and create an account.
Set `AUTH_ALLOW_SIGNUP=false` to close self-service sign-up.

`db:bootstrap` connects as the `postgres` superuser by default. Use another superuser with
`npm run db:bootstrap -- --superuser <name>`. If `psql` is not on PATH, it is looked up under
`C:\Program Files\PostgreSQL\<version>\bin`, or set `PSQL_PATH`.

## Running

```bash
npm run dev              # web (http://localhost:3000) + worker together, with reload
npm run dev:web          # web only
npm run dev:worker       # worker only
```

Production mode:

```bash
npm run build
npm run start:web
npm run start:worker
```

## Health checks

| Endpoint | Purpose |
|---|---|
| `GET http://localhost:3000/api/v1/health` | Web liveness (no dependencies) |
| `GET http://localhost:3000/api/v1/health/ready` | Config valid, PostgreSQL reachable, storage writable; 503 otherwise |
| `GET http://127.0.0.1:3001/health` | Worker status incl. database connectivity; 503 when degraded |

The **Settings** page shows the same live checks in the UI.

## API (Phase 2)

All `/api/v1` endpoints except health checks require a session cookie (sign in via the UI or
`POST /api/auth/sign-in/email`). Errors use `application/problem+json`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/projects?q=&page=&pageSize=` | List your projects (search, pagination) |
| POST | `/api/v1/projects` | Create `{ name, websiteUrl, scanDefaults? }` |
| GET | `/api/v1/projects/:id` | Project with last scan and issue counts |
| PATCH | `/api/v1/projects/:id` | Update name, website URL, scan defaults |
| DELETE | `/api/v1/projects/:id` | Soft delete |

Website URLs are validated before they are stored: only http/https, no embedded credentials,
no private/loopback/link-local/metadata addresses or local host names, except hosts listed in
`SCAN_ALLOWED_PRIVATE_HOSTS`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                 # unit + integration tests
npm run test:unit
npm run test:integration # needs TEST_DATABASE_URL (database name must end in _test)
```

Integration tests run against `TEST_DATABASE_URL` (created by `db:bootstrap`), apply migrations
automatically and truncate tables between tests. They refuse to run against a database whose
name does not end in `_test`.

HTTP smoke test against a running server (creates and later deletes throwaway accounts):

```bash
npm run smoke:phase2 -- create    # then restart the server
npm run smoke:phase2 -- verify    # checks data persisted, then cleans up
```

## Repository layout

```
apps/web           Next.js UI, auth, /api/v1 route handlers
apps/worker        Background worker (scan pipeline from Phase 4)
packages/core      Config validation, logging, error model, domain schemas
packages/db        Drizzle schema (24 tables), migrations, repositories, health check
packages/security  Website URL validation (SSRF rules), safe redirects
scripts/           Environment and database bootstrap scripts
tests/             Integration test setup, HTTP smoke tests
docs/              Architecture and design documents
```

## Configuration

All configuration comes from environment variables, documented in [.env.example](.env.example).
Both apps read the single `.env` at the repository root. Secrets are never logged or sent to the
browser; invalid configuration is reported by variable name only.
