#!/usr/bin/env node
// End-to-end HTTP smoke test against a RUNNING server (default http://localhost:3000).
// Usage:
//   node tests/smoke/phase2.mjs create   -> signs up two throwaway users, exercises the project API,
//                                            leaves one project and writes state to a temp file
//   (restart the server)
//   node tests/smoke/phase2.mjs verify   -> signs in again, confirms the project persisted,
//                                            then deletes the throwaway users
// Credentials are random per run and never printed.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const STATE = path.join(os.tmpdir(), "qa-copilot-phase2-smoke.json");
const mode = process.argv[2];
let failures = 0;

function check(label, condition, detail = "") {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${label}${!condition && detail ? ` (${detail})` : ""}`,
  );
  if (!condition) failures += 1;
}

async function call(method, url, { cookie, body, origin = BASE } = {}) {
  const headers = { origin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const setCookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: res.status, json, setCookie, location: res.headers.get("location") };
}

async function signUp(email, password) {
  const r = await call("POST", "/api/auth/sign-up/email", {
    body: { name: email.split("@")[0], email, password },
  });
  check(
    `sign up ${email}`,
    r.status === 200 && r.setCookie.includes("session_token"),
    `status ${r.status}`,
  );
  return r.setCookie;
}

async function signIn(email, password) {
  const r = await call("POST", "/api/auth/sign-in/email", { body: { email, password } });
  return r.status === 200 ? r.setCookie : null;
}

async function create() {
  const run = randomBytes(4).toString("hex");
  const users = [0, 1].map((i) => ({
    email: `smoke-${run}-${i}@example.test`,
    password: randomBytes(18).toString("base64url"),
  }));

  const anon = await call("GET", "/projects");
  check(
    "signed-out page visit redirects to /login",
    anon.status === 307 && anon.location?.includes("/login?next=%2Fprojects"),
    `status ${anon.status}`,
  );
  check("signed-out API call returns 401", (await call("GET", "/api/v1/projects")).status === 401);

  const a = await signUp(users[0].email, users[0].password);
  const b = await signUp(users[1].email, users[1].password);
  check(
    "wrong password is rejected",
    (await signIn(users[0].email, "not-the-password-123")) === null,
  );

  const created = await call("POST", "/api/v1/projects", {
    cookie: a,
    body: { name: "Smoke project", websiteUrl: "example.com" },
  });
  check("create project returns 201", created.status === 201, `status ${created.status}`);
  check("website URL normalized", created.json?.websiteUrl === "https://example.com/");
  const id = created.json?.id;

  const ssrf = await call("POST", "/api/v1/projects", {
    cookie: a,
    body: { name: "x", websiteUrl: "http://169.254.169.254/latest" },
  });
  check("metadata-service URL rejected (400)", ssrf.status === 400);
  const csrf = await call("POST", "/api/v1/projects", {
    cookie: a,
    origin: "https://evil.example",
    body: { name: "x", websiteUrl: "example.com" },
  });
  check("cross-origin write rejected (403)", csrf.status === 403);

  check(
    "owner can read project",
    (await call("GET", `/api/v1/projects/${id}`, { cookie: a })).status === 200,
  );
  check(
    "other user gets 404",
    (await call("GET", `/api/v1/projects/${id}`, { cookie: b })).status === 404,
  );
  check(
    "other user cannot delete (404)",
    (await call("DELETE", `/api/v1/projects/${id}`, { cookie: b })).status === 404,
  );

  const patched = await call("PATCH", `/api/v1/projects/${id}`, {
    cookie: a,
    body: { name: "Smoke project (renamed)" },
  });
  check(
    "owner can rename",
    patched.status === 200 && patched.json?.name === "Smoke project (renamed)",
  );

  const page = await call("GET", `/projects/${id}`, { cookie: a });
  check("project page renders for owner", page.status === 200);
  const foreignPage = await call("GET", `/projects/${id}`, { cookie: b });
  check("project page is 404 for other user", foreignPage.status === 404);

  const signOut = await call("POST", "/api/auth/sign-out", { cookie: a, body: {} });
  check("sign out succeeds", signOut.status === 200);
  check(
    "old session no longer valid",
    (await call("GET", "/api/v1/projects", { cookie: a })).status === 401,
  );

  writeFileSync(STATE, JSON.stringify({ users, id }), { mode: 0o600 });
  console.log(`\nState saved. Restart the server, then run: node tests/smoke/phase2.mjs verify`);
}

async function verify() {
  const { users, id } = JSON.parse(readFileSync(STATE, "utf8"));
  const a = await signIn(users[0].email, users[0].password);
  check("sign in after restart", Boolean(a));
  const r = await call("GET", `/api/v1/projects/${id}`, { cookie: a });
  check(
    "project persisted across restart",
    r.status === 200 && r.json?.name === "Smoke project (renamed)",
    `status ${r.status}`,
  );
  const del = await call("DELETE", `/api/v1/projects/${id}`, { cookie: a });
  check("owner can delete project", del.status === 204);
  check(
    "deleted project is gone",
    (await call("GET", `/api/v1/projects/${id}`, { cookie: a })).status === 404,
  );

  // Remove the throwaway accounts (cascades to their sessions and projects).
  const { default: pg } = await import("pg");
  const { config } = await import("dotenv");
  config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const removed = await client.query('delete from "user" where email = any($1)', [
    users.map((u) => u.email),
  ]);
  await client.end();
  check("throwaway users removed", removed.rowCount === users.length);
  rmSync(STATE, { force: true });
}

if (mode === "create") await create();
else if (mode === "verify") await verify();
else {
  console.error("usage: node tests/smoke/phase2.mjs create|verify");
  process.exit(2);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
