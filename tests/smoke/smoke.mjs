#!/usr/bin/env node
// Repeatable smoke test of a RUNNING installation (run it every time you start the project).
//
//   npm run smoke                 (web on :3000, worker on :3001, fixture site on :4100)
//
// It checks the health endpoints, signs up a throwaway account (random credentials, never
// printed), creates a project for the local fixture website with all six scanners, runs a scan of
// the site's version v1 and a second scan of version v2, and checks scanner steps, findings,
// evidence, issues, a JSON report, the scan history and the comparison of the two scans.
// Afterwards the throwaway account and its stored files are deleted (unless --keep is given).
//
// Settings (environment): SMOKE_BASE_URL (default http://localhost:3000), SMOKE_WORKER_URL
// (default http://127.0.0.1:3001), SMOKE_FIXTURE_URL (default http://localhost:4100).
// DATABASE_URL and STORAGE_DIR come from the repository's .env (for the cleanup).
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: path.join(ROOT, ".env"), quiet: true });

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const WORKER = process.env.SMOKE_WORKER_URL ?? "http://127.0.0.1:3001";
const FIXTURE = process.env.SMOKE_FIXTURE_URL ?? "http://localhost:4100";
const KEEP = process.argv.includes("--keep");
const SIX = ["accessibility", "security", "seo", "links", "performance", "responsive"];
const started = Date.now();
let failures = 0;
let cookie = "";

const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`.padStart(5);
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${elapsed()}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
  return ok;
}
const info = (text) => console.log(`     ${elapsed()}  ${text}`);

async function call(method, url, { body, auth = true, raw = false } = {}) {
  const headers = { origin: BASE };
  if (auth && cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url.startsWith("http") ? url : BASE + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (raw) return res;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs, everyMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

async function runScan(projectId, variant) {
  const auth = await call("PUT", `/api/v1/projects/${projectId}/scan-auth`, {
    body: { type: "header", name: "X-Fixture-Variant", value: variant },
  });
  check(
    `fixture version ${variant} selected (site credential)`,
    auth.status === 200,
    `HTTP ${auth.status}`,
  );
  const res = await call("POST", `/api/v1/projects/${projectId}/scans`, {
    body: { authorizationAttested: true },
  });
  if (!check(`scan of ${variant} queued`, res.status === 201, `HTTP ${res.status}`)) return null;
  const scanId = res.json.id;
  info(`waiting for scan #${res.json.number} (usually 1–2 minutes) …`);
  const scan = await waitFor(
    "scan to finish",
    async () => {
      const s = await call("GET", `/api/v1/scans/${scanId}`);
      return ["completed", "completed_with_failures", "failed", "cancelled"].includes(
        s.json?.status,
      )
        ? s.json
        : null;
    },
    { timeoutMs: 8 * 60_000 },
  );
  check(`scan #${scan.number} finished as "completed"`, scan.status === "completed", scan.status);
  return scan;
}

async function cleanup(email) {
  if (KEEP || !process.env.DATABASE_URL) {
    info(KEEP ? `kept the throwaway account ${email}` : "no DATABASE_URL: account not deleted");
    return;
  }
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const scans = await db.query(
      `select s.id from scan s join project p on p.id = s.project_id
       join "user" u on u.id = p.owner_id where u.email = $1`,
      [email],
    );
    const projects = await db.query(
      `select p.id from project p join "user" u on u.id = p.owner_id where u.email = $1`,
      [email],
    );
    await db.query('delete from "user" where email = $1', [email]);
    const storage = path.resolve(ROOT, process.env.STORAGE_DIR ?? "./storage");
    for (const { id } of scans.rows) {
      await rm(path.join(storage, "scans", id), { recursive: true, force: true });
      await rm(path.join(storage, "reports", id), { recursive: true, force: true });
    }
    for (const { id } of projects.rows)
      await rm(path.join(storage, "projects", id), { recursive: true, force: true });
    info("throwaway account, its projects, scans and files deleted");
  } finally {
    await db.end();
  }
}

async function main() {
  console.log(`QA Copilot smoke test against ${BASE} (worker ${WORKER}, fixture ${FIXTURE})`);

  // 1. Services
  const health = await call("GET", "/api/v1/health", { auth: false }).catch(() => null);
  if (
    !check(
      "web app is running",
      health?.status === 200,
      health ? `HTTP ${health.status}` : "not reachable",
    )
  )
    throw new Error(`Start the web app first (npm run dev:web or npm run start:web) on ${BASE}`);
  const ready = await call("GET", "/api/v1/health/ready", { auth: false });
  check(
    "web app is ready (config, database, migrations, storage)",
    ready.json?.status === "ready",
    JSON.stringify(ready.json?.checks ?? {}).slice(0, 200),
  );
  const worker = await fetch(`${WORKER}/health`)
    .then((r) => r.json())
    .catch(() => null);
  check(
    "worker is running (scans, documents, reports)",
    worker?.status === "ok" &&
      worker?.scanWorker?.status === "running" &&
      worker?.referenceWorker?.status === "running" &&
      worker?.reportWorker?.status === "running",
    worker
      ? JSON.stringify({ status: worker.status, scan: worker.scanWorker?.status })
      : "not reachable (npm run dev:worker)",
  );
  const fixture = await fetch(FIXTURE).catch(() => null);
  if (
    !check(
      "fixture website is running",
      fixture?.status === 200,
      fixture ? `HTTP ${fixture.status}` : "not reachable",
    )
  )
    throw new Error("Start the fixture website first: npm run demo:site");

  // 2. Authentication
  const email = `smoke-${randomBytes(4).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const signup = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ name: "Smoke Test", email, password }),
  });
  cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (
    !check(
      "throwaway account signed up",
      signup.status === 200 && cookie.includes("session_token"),
      `HTTP ${signup.status}`,
    )
  )
    throw new Error(
      "Sign-up failed (is AUTH_ALLOW_SIGNUP=true? sign-ups are limited to 5 per minute)",
    );
  try {
    const anonymous = await call("GET", "/api/v1/projects", { auth: false });
    check(
      "API refuses requests without a session",
      anonymous.status === 401,
      `HTTP ${anonymous.status}`,
    );
    const page = await call("GET", "/dashboard", { auth: false, raw: true });
    check(
      "app pages redirect signed-out visitors to /login",
      page.status === 307 && (page.headers.get("location") ?? "").includes("/login"),
      `HTTP ${page.status}`,
    );
    const csp =
      (await call("GET", "/login", { auth: false, raw: true })).headers.get(
        "content-security-policy",
      ) ?? "";
    check("pages send the nonce-based Content-Security-Policy", /script-src[^;]*'nonce-/.test(csp));

    // 3. Project for the fixture website (all six scanners)
    const created = await call("POST", "/api/v1/projects", {
      body: {
        name: `Smoke ${new Date().toISOString().slice(0, 16)}`,
        websiteUrl: FIXTURE,
        scanDefaults: {
          scanners: SIX,
          viewports: [
            { name: "desktop", width: 1440, height: 900 },
            { name: "mobile", width: 390, height: 844 },
          ],
          // The whole fixture site (v2 adds its new defect on /blog/post-1).
          maxPages: 25,
          maxDepth: 2,
          respectRobots: true,
        },
      },
    });
    if (
      !check(
        "project created for the fixture website",
        created.status === 201,
        `HTTP ${created.status}`,
      )
    )
      return;
    const projectId = created.json.id;
    const bad = await call("POST", "/api/v1/projects", {
      body: { name: "Blocked", websiteUrl: "http://169.254.169.254/latest/meta-data" },
    });
    check(
      "internal/metadata addresses are refused (SSRF guard)",
      bad.status === 400,
      `HTTP ${bad.status}`,
    );

    // 4. First scan (site version v1)
    const scan1 = await runScan(projectId, "v1");
    if (!scan1) return;
    const steps = Object.fromEntries(scan1.runs.map((r) => [r.stepKey, r]));
    for (const key of ["preflight", "crawl", "capture"])
      check(`step ${key} completed`, steps[key]?.status === "completed", steps[key]?.status);
    for (const key of SIX)
      check(
        `scanner ${key} completed`,
        steps[key]?.status === "completed",
        `${steps[key]?.status}, ${steps[key]?.findingCount ?? 0} findings`,
      );
    check(
      "AI step ran or was skipped with a reason",
      ["completed", "skipped"].includes(steps.ai?.status),
      `${steps.ai?.status}: ${steps.ai?.statusReason ?? steps.ai?.error ?? ""}`.slice(0, 120),
    );
    check(
      "evidence validation (grounding) completed",
      steps.grounding?.status === "completed",
      steps.grounding?.status,
    );
    check(
      `pages crawled and captured`,
      scan1.pageCount > 0 && scan1.captureCount > 0,
      `${scan1.pageCount} pages, ${scan1.captureCount} captures`,
    );

    const findings = await call("GET", `/api/v1/scans/${scan1.id}/findings`);
    const items = findings.json?.items ?? [];
    check(
      "findings stored",
      findings.status === 200 && items.length > 0,
      `${findings.json?.total ?? 0} findings`,
    );
    const scannersWithFindings = new Set(items.map((f) => f.scanner));
    check(
      "every scanner produced findings on the fixture's known defects",
      SIX.every((s) => scannersWithFindings.has(s)),
      [...scannersWithFindings].join(", "),
    );
    check(
      "every finding carries evidence",
      items.length > 0 && items.every((f) => f.evidence?.length > 0),
    );

    const issues = await call("GET", `/api/v1/scans/${scan1.id}/issues`);
    const list = issues.json?.issues ?? issues.json?.items ?? [];
    check(
      "issues created from the findings",
      issues.status === 200 && list.length > 0,
      `${list.length} issues`,
    );

    // 5. JSON report generated by the worker from the stored records
    const report = await call("POST", `/api/v1/scans/${scan1.id}/reports`, {
      body: { format: "json" },
    });
    if (check("JSON report requested", report.status === 202, `HTTP ${report.status}`)) {
      const done = await waitFor(
        "report",
        async () => {
          const r = await call("GET", `/api/v1/reports/${report.json.id}`);
          return ["completed", "failed"].includes(r.json?.status) ? r.json : null;
        },
        { timeoutMs: 120_000, everyMs: 1000 },
      );
      if (check("report generated", done.status === "completed", done.error ?? done.status)) {
        const file = await call("GET", done.downloadUrl);
        check(
          "report contains the scan's issues",
          file.status === 200 && file.json?.issues?.length === list.length,
          `${file.json?.issues?.length} in report, ${list.length} in the app`,
        );
      }
    }

    // 6. Second scan (site version v2), history and comparison
    const scan2 = await runScan(projectId, "v2");
    if (!scan2) return;
    const history = await call("GET", `/api/v1/projects/${projectId}/history`);
    check(
      "scan history lists both scans",
      history.status === 200 && (history.json?.items?.length ?? 0) >= 2,
      `${history.json?.items?.length ?? 0} scans`,
    );
    const cmp = await call("GET", `/api/v1/projects/${projectId}/comparisons`);
    const counts = cmp.json?.summary?.counts ?? {};
    check(
      "comparison of scan #1 and #2 computed",
      cmp.status === 200 && cmp.json?.comparable === true,
      JSON.stringify(counts),
    );
    check(
      "comparison finds resolved and new issues (v1 → v2)",
      counts.resolved > 0 && counts.new > 0,
      `resolved ${counts.resolved}, new ${counts.new}, persistent ${counts.persistent}`,
    );
    info(`app: ${BASE}/projects/${projectId}/history (removed at cleanup unless --keep)`);
  } finally {
    await cleanup(email);
  }
}

main()
  .catch((err) => {
    console.log(`FAIL ${elapsed()}  ${err.message}`);
    failures += 1;
  })
  .finally(() => {
    console.log(
      failures
        ? `\nSMOKE TEST FAILED (${failures} check${failures === 1 ? "" : "s"})`
        : "\nSMOKE TEST PASSED",
    );
    process.exitCode = failures ? 1 : 0;
  });
