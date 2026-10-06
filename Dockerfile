# syntax=docker/dockerfile:1
#
# QA Copilot: one build, two runtime targets (see docs/DEPLOYMENT.md).
#   web     Next.js UI + /api/v1                     docker build --target web -t qa-copilot-web .
#   worker  scans, documents, Figma, reports (+ Chromium); also runs the database migrations
#                                                    docker build --target worker -t qa-copilot-worker .
#
# NOT VERIFIED: Docker was not available on the machine this was written on. The build steps are
# the same commands that were verified natively (npm ci, npm run build, next start, tsx worker).

ARG NODE_VERSION=22.16.0

# ---- dependencies (cached until a package.json or the lockfile changes) ------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/browser/package.json packages/browser/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/crawler/package.json packages/crawler/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/reference/package.json packages/reference/package.json
COPY packages/reports/package.json packages/reports/package.json
COPY packages/scanners/package.json packages/scanners/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN npm ci --no-audit --no-fund

# ---- build: Next.js production build, then drop development-only packages -----------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- shared runtime ------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    STORAGE_DIR=/app/storage
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Screenshots, uploads and reports. Mount the same volume into web and worker.
RUN mkdir -p /app/storage && chown node:node /app/storage
VOLUME ["/app/storage"]

# ---- web -----------------------------------------------------------------------------------------
FROM runtime AS web
USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]

# ---- worker --------------------------------------------------------------------------------------
FROM runtime AS worker
# Chromium and its system libraries, at the version the lockfile's Playwright expects.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WORKER_HEALTH_HOST=0.0.0.0 \
    WORKER_HEALTH_PORT=3001
RUN npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /ms-playwright
USER node
WORKDIR /app/apps/worker
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/index.ts"]
