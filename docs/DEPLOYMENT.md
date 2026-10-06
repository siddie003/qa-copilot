# Deploying QA Copilot

QA Copilot runs as two processes that share one PostgreSQL database and one storage folder:

| Component | What it does | Listens on |
|---|---|---|
| **web** (`apps/web`, Next.js) | UI, `/api/v1`, authentication, uploads, downloads, live scan status (SSE) | 3000 (HTTP) |
| **worker** (`apps/worker`) | scans (crawler + Chromium + scanners + AI/grounding), document parsing, Figma reads, report generation | 3001 health endpoint only |
| **PostgreSQL** 15+ (developed on 18) | all records; also the job queue (`SKIP LOCKED` + `LISTEN/NOTIFY`) | 5432 |
| **storage folder** (`STORAGE_DIR`) | screenshots, HTML snapshots, uploaded documents, reports | shared by web and worker |

**What was verified.** The native setup below (production build, `next start`, the worker, migrations,
health checks, the full unit/integration/end-to-end test suites) was run on Windows 11 with
Node.js 22.16 and PostgreSQL 18.6. **The Docker files (`Dockerfile`, `docker-compose.yml`) were
written but not built or run** — Docker was not available on that machine. Treat them as a
starting point and test them in your environment.

## 1. Requirements

- Node.js 22.12+ and npm 10+ (native setup), or Docker with Compose v2.
- PostgreSQL 15+ with a dedicated database and role (`npm run db:bootstrap` creates them locally).
- For the worker: Chromium installed by Playwright (`npx playwright install --with-deps chromium`),
  about 1 GB RAM per concurrent scan, outbound internet access to the sites you scan.
- A TLS-terminating reverse proxy (nginx, Caddy, a load balancer) in front of the web app.

## 2. Configuration for production

All settings are environment variables (see [.env.example](../.env.example) for every variable
and its default). The process environment always wins over a `.env` file; containers should get
their settings from the environment, never from a file baked into an image.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (`next start` sets it for the web process; set it for the worker) |
| `APP_URL` | the public `https://` address; it decides Secure cookies, HSTS and the allowed request origin |
| `DATABASE_URL` | `postgres://…` of the application role (not a superuser) |
| `BETTER_AUTH_SECRET` | 32+ random characters; changing it signs everyone out |
| `ENCRYPTION_KEY` | 64 hex characters, **required in production**; encrypts stored site credentials and Figma tokens. Back it up: without it those secrets cannot be decrypted (there is no key rotation) |
| `AUTH_ALLOW_SIGNUP` | `false` once your accounts exist |
| `TRUSTED_PROXIES` | the reverse proxy address(es) as seen by the web process (IPs or CIDR ranges) |
| `CLIENT_IP_HEADER` | the header your proxy sets with the client IP (default `x-forwarded-for`) |
| `RATE_LIMIT_ENABLED` | `true` (default) |
| `STORAGE_DIR` | an absolute path on persistent storage, the same for web and worker |
| `SCAN_ALLOWED_PRIVATE_HOSTS` | empty, unless internal hosts are authorized scan targets |
| `WORKER_HEALTH_HOST` | `0.0.0.0` in containers (so probes can reach `/health`), else `127.0.0.1` |
| `WORKER_SHUTDOWN_GRACE_MS` | below your orchestrator's kill timeout (default 20000) |
| `DEMO_MODE_ENABLED` | `false` |
| AI / Figma | optional: `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, `FIGMA_ACCESS_TOKEN` |

Invalid configuration stops the worker at start and makes the web readiness check fail; errors
name the variable, never its value. Valid but risky production settings (HTTP `APP_URL`, open
sign-up, internal scan hosts allowed, rate limits off, no trusted proxies) are logged as
`configuration warning` when each process starts and listed on the **Settings** page.

## 3. Option A: Docker Compose (not verified)

```bash
cp deploy.env.example deploy.env        # fill in APP_URL, POSTGRES_PASSWORD, BETTER_AUTH_SECRET, ENCRYPTION_KEY …
docker compose --env-file deploy.env up -d --build
docker compose --env-file deploy.env ps
```

- `migrate` applies database migrations and exits; `web` and `worker` start only after it
  succeeded. Re-run it after every upgrade (`docker compose … up -d --build` does).
- The web port is bound to `127.0.0.1` (`WEB_BIND`) so only the reverse proxy on the same host
  reaches it. PostgreSQL is on an internal network without a published port.
- `storage` and `pgdata` are named volumes; back them up (section 6).
- The worker image contains Chromium (`npx playwright install --with-deps chromium`) and runs as
  the unprivileged `node` user. `shm_size: 1gb` and `--disable-dev-shm-usage` keep Chromium stable.
- Both images run as non-root, have `HEALTHCHECK`s and get `init: true` (signal forwarding).

## 4. Option B: native processes (verified on Windows; the Linux unit files are examples)

```bash
npm ci
npx playwright install --with-deps chromium     # worker host only
npm run build                                   # Next.js production build
npm run db:migrate                              # before starting new code, every upgrade
npm run start:web                               # next start on port 3000
npm run start:worker                            # scan/reference/report worker
```

Run both under a supervisor that restarts them. Example systemd unit for the worker:

```ini
[Unit]
Description=QA Copilot worker
After=network-online.target postgresql.service

[Service]
User=qacopilot
WorkingDirectory=/opt/qa-copilot/apps/worker
EnvironmentFile=/etc/qa-copilot/env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always
# Must exceed WORKER_SHUTDOWN_GRACE_MS plus ~30 s to record the state of stopped scans.
TimeoutStopSec=60
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/qa-copilot/storage
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

The web unit is the same with `WorkingDirectory=/opt/qa-copilot/apps/web` and
`ExecStart=/usr/bin/node /opt/qa-copilot/node_modules/next/dist/bin/next start --port 3000`.
`npm ci --omit=dev` is enough at runtime once `.next` has been built (`tsx`, which runs the worker
and the migrations, is a runtime dependency).

## 5. Reverse proxy and TLS

The proxy terminates TLS, **overwrites** the client IP header (never appends a client-supplied
one), streams Server-Sent Events without buffering and allows uploads up to `MAX_UPLOAD_MB`.
Example for nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name qa.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  client_max_body_size 21m;                  # MAX_UPLOAD_MB + 1

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite: clients cannot choose their IP
  }
  location ~ ^/api/v1/scans/[^/]+/events$ {          # live scan status (SSE)
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

Then set `APP_URL=https://qa.example.com` and `TRUSTED_PROXIES=127.0.0.1` (the address the proxy
connects from). Without a proxy that overwrites the header, anyone reaching the app directly can
pick the IP the per-IP sign-in limits see; the per-account sign-in limit still applies.

## 6. Operations

**Health checks**

| Endpoint | Meaning |
|---|---|
| `GET /api/v1/health` (web) | liveness; no dependencies |
| `GET /api/v1/health/ready` (web) | configuration valid, PostgreSQL reachable, migrations applied, storage writable; 503 otherwise. Public, so results are reused for 2 s and details (paths, variable names) are hidden in production |
| `GET http://<worker>:3001/health` | worker liveness/readiness: database, scan/reference/report loops, current scans; 503 when the database is unreachable |

**Logs.** Both processes write one JSON object per line to stdout (pino): `requestId`, `route`,
`status`, `durationMs`, `userId`, `scanId`, `step`, error name/code/message. Secrets are redacted
by key (`password`, `token`, `apiKey`, `authorization`, `cookie`, the secret variables) and
database errors never include bound query parameters. Ship stdout to your log system.

**Shutdown and recovery.** On SIGTERM the worker stops taking jobs; running scans may finish
within `WORKER_SHUTDOWN_GRACE_MS`, then they are stopped and recorded as *failed — the worker was
shut down* (everything stored so far is kept). Scans whose worker died are failed after 2 minutes
without a heartbeat; documents, Figma reads and reports left running are failed with a retry hint
after 5 minutes. Recovery runs at start and every minute on every worker, so a crashed worker that
never returns cannot block a project.

**Scaling.** Run any number of workers (jobs are claimed with `SKIP LOCKED`; `WORKER_CONCURRENCY`
scans per worker, each with its own Chromium). Run **one web instance** per deployment: per-user
API rate limits, the per-account sign-in limit and Better Auth's per-IP limits are kept in the
web process's memory, so several instances would each enforce their own limits (everything else
works with several instances).

**Backups.** `pg_dump` the database and copy the storage folder (same point in time if possible).
Keep `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` in your secret store; a restore needs both.

**Upgrades.** Back up, deploy the new code, run `npm run db:migrate` (or the `migrate` service),
then restart web and worker. The worker refuses to process scans while migrations are pending and
readiness reports them. Migration `0006_production_hardening` adds a unique index allowing one
queued/running scan per project; it first cancels queued duplicates (with a reason). If two scans
of one project are *running* when it is applied, it fails: wait for them to finish and run it
again.

**Storage cleanup.** Files whose rows are gone (e.g. after a database cascade) are not removed
automatically. Review and remove them with the garbage collector (dry run by default; only files
older than 24 hours; soft-deleted projects only on request; unknown files are never touched):

```bash
npm run storage:gc
npm run storage:gc -- --apply
npm run storage:gc -- --apply --include-deleted-projects --min-age-hours=168
```

Run it against the database that owns `STORAGE_DIR` only (never share one storage folder between
two databases).

## 7. Security checklist

- [ ] HTTPS only; `APP_URL` is the `https://` address (Secure cookies, HSTS, `upgrade-insecure-requests`).
- [ ] Reverse proxy overwrites `X-Forwarded-For` (or `CLIENT_IP_HEADER`); `TRUSTED_PROXIES` set.
- [ ] `AUTH_ALLOW_SIGNUP=false` after creating accounts; `DEMO_MODE_ENABLED=false`.
- [ ] `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` generated randomly, stored as secrets, backed up.
- [ ] `SCAN_ALLOWED_PRIVATE_HOSTS` empty unless internal targets are authorized.
- [ ] **Worker egress restricted at the network level** as defense in depth: the application
      blocks private, loopback, link-local and metadata addresses before every request, at every
      redirect and at connect time, and routes Chromium through a guard proxy, but a firewall rule
      denying the worker access to your internal networks (and `169.254.169.254`) protects
      against anything the application cannot see.
- [ ] Worker isolated from other workloads: it renders untrusted websites in Chromium, which
      Playwright starts **without Chromium's own sandbox**; run it in its own container/VM as an
      unprivileged user with nothing mounted except the storage folder.
- [ ] PostgreSQL not reachable from the internet; the application role is not a superuser.
- [ ] Logs collected; alerts on `level=error`/`fatal`, on readiness 503 and on worker health 503.
- [ ] Backups of the database, the storage folder and the two secrets tested by restoring.

## 8. Known limitations (deployment)

- Docker images and Compose file are unverified (no Docker on the development machine).
- Rate limits are per web process (see Scaling).
- Local filesystem storage only (`STORAGE_DIR`); no S3 implementation yet.
- No automatic storage garbage collection (manual `storage:gc`).
- No `ENCRYPTION_KEY` rotation; no user/admin management UI (accounts are created by sign-up).
- Chromium runs without its sandbox (Playwright default); isolate the worker as described.
