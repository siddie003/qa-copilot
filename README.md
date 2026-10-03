# QA Copilot

AI-powered website QA, design and brand compliance platform. You provide a design reference
(Figma or brand guidelines), approved content and a website URL; QA Copilot crawls the site,
runs evidence-based QA scanners, and turns the findings into developer-ready issues and reports.

> **Status:** Phase 1 (project foundation). See [PROJECT_STATUS.md](PROJECT_STATUS.md) and
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
```

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

## Quality checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test                 # set TEST_DATABASE_URL to also run live database tests
```

## Repository layout

```
apps/web        Next.js UI + /api/v1 route handlers
apps/worker     Background worker (scan pipeline from Phase 4)
packages/core   Config validation, logging, error model
packages/db     PostgreSQL client, health check, migrations
scripts/        Environment and database bootstrap scripts
docs/           Architecture and design documents
```

## Configuration

All configuration comes from environment variables, documented in [.env.example](.env.example).
Both apps read the single `.env` at the repository root. Secrets are never logged or sent to the
browser; invalid configuration is reported by variable name only.
