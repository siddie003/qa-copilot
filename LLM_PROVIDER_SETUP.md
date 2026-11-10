# LLM Provider Setup

QA Copilot works without any AI (`AI_PROVIDER=none`): the six scanners, design and content
comparisons, issues, reports and history all run, and every issue uses the scanner's own wording
plus rule-catalog fix guidance. AI is optional and only **explains** evidence: it writes issue
text and helps read brand-guideline documents. Every AI answer is checked against the stored
evidence by the grounding validator; unsupported parts are replaced with the scanner's wording.

Supported providers (`AI_PROVIDER`):

| Value | API | Notes |
|---|---|---|
| `none` | — | Default. No data leaves the installation. |
| `gemini` | Google Gemini API, OpenAI-compatible endpoint | **Recommended free tier** (see limits and data use below) |
| `groq` | Groq API (OpenAI-compatible) | Free plan alternative; very small per-minute token budget |
| `anthropic` | Anthropic Messages API (official SDK) | Paid |
| `openai-compatible` | Any Chat Completions server (`OPENAI_BASE_URL`) | OpenAI, Azure OpenAI, vLLM, LM Studio, Ollama, … |

The provider never changes by itself: if the configured provider fails, the affected issues keep
the scanner's wording and the failure is recorded on the scan's AI step and in `ai_run`.

---

## 0. Live verification on this installation (2026-10-10)

First real use of a provider (Gemini free tier, key in `.env` only). Measured on this machine;
provider load changes during the day, so treat the numbers as a snapshot.

- `npm run ai:check` (one tiny structured-output request) per model:
  `gemini-3.8-flash` 59–91 s (Google returned HTTP 503 "This model is currently experiencing high
  demand"; also seen with a plain request), `gemini-3.7-flash` 20.7 s, **`gemini-3.6-flash`
  2.4–3.4 s** (chosen), `gemini-3.5-flash` 3.9 s, `gemini-3.5-flash-lite` 1.9 s.
- **Free-tier limit seen live** for `gemini-3.6-flash`: **5 requests per minute** per project
  (`QuotaFailure` quota id `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, `quotaValue`
  5, `RetryInfo` 43 s). The daily limit was not reached and is not known; check AI Studio →
  Rate limits.
- **Defect found and fixed:** Google uses the same message ("You exceeded your current quota,
  please check your plan and billing details …") for per-minute and per-day limits. The
  classifier matched the message and treated a per-minute limit as an exhausted quota, which
  stopped AI for the rest of the scan. Structured quota ids now decide (per day → quota
  exhausted; per second/minute/hour → wait and retry); the message is used only without ids.
- Settings used: `AI_PROVIDER=gemini`, `AI_MODEL=gemini-3.6-flash`, `AI_CONCURRENCY=2`,
  `AI_REQUESTS_PER_MINUTE=5`, `AI_TEMPERATURE` empty (not sent).
- End-to-end scans on the disposable test database: see `PROJECT_STATUS.md` → "Live AI".

## 1. Provider research (verified 2026-10-09)

Facts below were read from the providers' official pages on 2026-10-09. Free tiers change
without notice: check the linked pages before relying on them. Nothing here is a promise of
free or unlimited use.

### Google Gemini API — primary free-tier choice
- **Free tier exists** for stable text models including `gemini-3.8-flash`, `gemini-3.7-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`
  (input and output "Free of charge") — [pricing](https://ai.google.dev/gemini-api/docs/pricing),
  page dated 2026-10-07.
- **Rate limits:** measured as requests per minute (RPM), input tokens per minute (TPM) and
  requests per day (RPD), applied **per project, not per API key**; exceeding any one returns an
  error; RPD resets at midnight Pacific time. The **numeric free-tier limits are not published on
  the docs page**; they are shown per project in Google AI Studio
  (aistudio.google.com/rate-limit) — [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits),
  dated 2026-09-02. **We do not state numbers we could not verify.**
- **Context:** `gemini-3.8-flash` accepts 1,048,576 input tokens and produces up to 65,536 output
  tokens; structured outputs and thinking (low/medium/high) supported —
  [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
- **OpenAI compatibility:** base URL `https://generativelanguage.googleapis.com/v1beta/openai/`,
  `Authorization: Bearer <GEMINI_API_KEY>`; structured output works with the OpenAI
  `response_format` JSON-schema form; `reasoning_effort` supported; the compatibility layer is
  described as **beta** — [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).
- **Temperature:** Google recommends keeping Gemini 3's default temperature (1.0); lower values
  may cause looping or degraded output — [Gemini 3 prompting guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide).
  QA Copilot therefore sends no temperature for `gemini` unless `AI_TEMPERATURE` is set.
- **Data use on the free tier** — [Gemini API terms](https://ai.google.dev/gemini-api/terms):
  - Google uses content submitted to the unpaid services and the responses to improve its
    products; human reviewers may read and annotate inputs and outputs.
  - Google says: do not submit sensitive, confidential or personal information to the unpaid
    services. The paid tier's content is not used to improve products
    ([pricing](https://ai.google.dev/gemini-api/docs/pricing)).
  - Apps made available to users in the EEA, Switzerland or the UK may use **paid services only**.
  - Users must be 18 or older.
- **Commercial use:** the terms above permit API use under their conditions; whether the free
  tier suits a commercial workload must be judged against those terms (not verified further).

### Groq — alternative
- **Production models** include `openai/gpt-oss-120b`, `openai/gpt-oss-20b`
  (131,072-token context, 65,536 max completion), `llama-3.3-70b-versatile`,
  `llama-3.1-8b-instant` — [models](https://console.groq.com/docs/models).
- **Structured outputs:** strict mode (`strict: true`, constrained decoding) on
  `openai/gpt-oss-20b`, `openai/gpt-oss-120b` (and the preview `qwen/qwen3.8-27b`); other models
  only have best-effort schema following or JSON-object mode; best-effort mismatches return HTTP
  400 "Generated JSON does not match the expected schema" —
  [structured outputs](https://console.groq.com/docs/structured-outputs). Streaming is not
  supported with structured outputs (QA Copilot does not stream on this path).
- **Rate limits:** per organization; HTTP 429 with `retry-after`; `x-ratelimit-*` headers —
  [rate limits](https://console.groq.com/docs/rate-limits). The docs table we could read is
  labelled as the Developer plan's base limits (e.g. `openai/gpt-oss-120b`: 30 RPM, 1K RPD,
  8K TPM, 200K TPD); several third-party summaries report the **same numbers for the free plan**,
  but we could not read the free-plan tab itself — **treat the free-plan numbers as unverified**
  and check your Groq console.
- **Data:** "By default, Groq does not retain customer data for inference requests"; logs may be
  kept up to 30 days for troubleshooting/abuse investigation; Zero Data Retention can be enabled
  in Data Controls; stored data is in US-based Google Cloud buckets —
  [your data](https://console.groq.com/docs/your-data). The page does not say whether Groq trains
  on API data (unverified).
- **Practical consequence:** with ~8K tokens per minute, one QA Copilot request must stay small
  (see the recommended settings), and a large scan needs many minutes of AI time or will only be
  partly interpreted (the rest keeps the scanners' wording, which the scan page states).

### Why Gemini first
Large context and output limits, strict structured output through the existing adapter, and a
free tier on current stable models. Its free-tier data use is the main drawback, so the Settings
page and `npm run ai:check` show the data-use notice. For confidential sites or documents use a
paid (billing-enabled) Gemini project, Groq with Zero Data Retention, or keep AI off.

---

## 2. Setup (Windows / PowerShell)

1. Get a key:
   - Gemini: create an API key in Google AI Studio (https://aistudio.google.com/apikey).
   - Groq: create an API key in the Groq console (https://console.groq.com/keys).
2. Edit `.env` in the repository root (never commit it):

   ```dotenv
   # Gemini (free tier)
   AI_PROVIDER=gemini
   AI_MODEL=gemini-3.8-flash
   GEMINI_API_KEY=<your key>
   AI_TEMPERATURE=
   # Optional pacing: copy your project's limits from AI Studio (Rate limits page)
   AI_REQUESTS_PER_MINUTE=0
   AI_TOKENS_PER_MINUTE=0
   AI_CONCURRENCY=2
   ```

   ```dotenv
   # Groq (free plan; numbers are examples — use the limits shown in your console)
   AI_PROVIDER=groq
   AI_MODEL=openai/gpt-oss-120b
   GROQ_API_KEY=<your key>
   AI_TEMPERATURE=
   AI_REQUESTS_PER_MINUTE=30
   AI_TOKENS_PER_MINUTE=8000
   AI_MAX_INPUT_TOKENS=3000
   AI_MAX_OUTPUT_TOKENS=3000
   AI_CONCURRENCY=1
   AI_MAX_ISSUES_PER_SCAN=60
   ```

3. Check the configuration (sends **one** tiny request; no scan data):

   ```powershell
   npm run ai:check
   ```

   It prints the provider, model, limits, the data-use notice, and `OK` with the answering model,
   latency and token usage, or `FAILED (<code>)` with what to change. Exit code 0 = OK or AI off.
4. Restart the worker (`npm run dev`, or `npm run start:worker`) so it reads the new settings.
   The Settings page shows the provider, the limits and the data-use notice.

---

## 3. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `none` | `none`, `gemini`, `groq`, `anthropic`, `openai-compatible` |
| `AI_MODEL` | — | Required with a provider |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | Key of the selected provider (required for it; redacted from logs) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | `openai-compatible` only |
| `AI_TIMEOUT_MS` | 300000 | Per request, including retries and waits |
| `AI_MAX_RETRIES` | 3 | Retries after 429 (per-minute), 5xx, 408 and network errors |
| `AI_MAX_RETRY_WAIT_MS` | 60000 | Longest `Retry-After` honoured; a longer requested wait ends the request (> 10 min counts as an exhausted quota) |
| `AI_REQUESTS_PER_MINUTE` | 0 | Client-side request pacing per worker process (0 = off) |
| `AI_TOKENS_PER_MINUTE` | 0 | Client-side token pacing per worker process (0 = off) |
| `AI_MAX_INPUT_TOKENS` | 20000 | Estimated input tokens per request; issue batches are cut to fit |
| `AI_MAX_OUTPUT_TOKENS` | 16000 | `max_tokens` per request (includes thinking on thinking models) |
| `AI_MAX_ISSUES_PER_SCAN` | 200 | Issues per scan sent to AI; the rest keep the scanners' wording |
| `AI_CONCURRENCY` | 3 | Parallel AI requests per scan |
| `AI_STRUCTURED_OUTPUT` | `json_schema` | `json_object` for models without strict JSON-schema support (schema goes into the prompt; answers are still validated) |
| `AI_TEMPERATURE` | unset | Unset: `openai-compatible` sends 0, `gemini`/`groq` send none |
| `AI_EFFORT` | unset | Anthropic `effort`; for OpenAI-style providers sent as `reasoning_effort` (`xhigh`/`max` → `high`) |
| `AI_REFUSAL_FALLBACK` | true | Anthropic only |

Token estimates use 3 characters per token (JSON-heavy input). The pacer reserves the estimated
input plus `AI_MAX_OUTPUT_TOKENS` per request and replaces the estimate with the reported usage
afterwards. Whether a provider counts `max_tokens` against its per-minute budget is not documented
for every provider, so the reservation is deliberately conservative.

---

## 4. How requests behave

- **Batches:** one finding category per request, ≤ 10 issue groups, ≤ `AI_MAX_INPUT_TOKENS`.
  A single group too large for one request is not sent (`too_large_input`) and keeps the
  scanners' wording.
- **Retries:** full-jitter exponential backoff (1 s, 2 s, 4 s … capped at 30 s) unless the
  provider states a wait (`Retry-After` seconds or HTTP date, or Google's `RetryInfo`).
  Cancellation and the step's time budget interrupt waits immediately.
- **Error classes** (stored on `ai_run.error` as `<code>: <message>`):

  | Code | Typical cause | Retried | Further requests of the scan |
  |---|---|---|---|
  | `rate_limit` | per-minute limit (429) | yes | continue |
  | `unavailable` | 5xx, 408 | yes | continue |
  | `network`, `timeout` | connection, `AI_TIMEOUT_MS` | network yes | continue |
  | `quota_exhausted` | daily/billing quota (429 with per-day quota id, `insufficient_quota`, TPD), very long Retry-After | no | **not sent** |
  | `auth` | 401/403, Gemini 400 `API_KEY_INVALID` | no | not sent |
  | `not_found` | unknown model | no | not sent |
  | `too_large` | 413, request above the token budget | no | not sent |
  | `bad_request` | other 400/422 | no | not sent |
  | `invalid_output` | malformed JSON, schema mismatch (incl. Groq best-effort 400) | no | continue |
  | `truncated` | `finish_reason=length` | no | continue |
  | `refusal` | provider declined | no | continue |

- **Output per issue** (prompt `issues-2026-10-11-explain`): title, description, severity and
  rationale, element, expected/actual, recommendation, cited claims and an optional
  plain-language `explanation` (problem, impact, next step, 2–6 fix steps, caveats; no code).
  Every part is checked against the evidence; unsupported parts are replaced by the built-in
  guide. Live Gemini runs used about 300–450 output tokens per issue before the explanation was
  added; with it an estimated 600–850 — a 10-issue batch stays below `AI_MAX_OUTPUT_TOKENS=16000`
  (not yet measured live).
- **What is recorded:** one `ai_run` per sent request (status, model that answered, input/output
  tokens when the provider reports them, latency, attempts, error). Prompts and responses are
  never stored. The scan's AI step says how many requests were answered and how many issues kept
  the scanners' wording, and why.
- **Error messages** contain at most 200 characters of the provider's own message, on one line,
  with the API key and key-shaped strings removed.

## 5. What is sent, and what is not

Sent: for each issue group, up to 5 sample findings (titles, messages, selectors, expected/actual
values, page URLs, non-screenshot evidence, each string ≤ 240 characters), the group's counts and
the rule-catalog fix text; for guideline documents, the lines that mention design values (bounded
by `AI_MAX_INPUT_TOKENS`). Not sent: screenshots, full HTML, site credentials, API keys, user
accounts. Before sending, credential-shaped strings (private keys, Google/Stripe/OpenAI/Groq/
GitHub/Slack keys, JWTs, Bearer/Basic tokens) and the values of credential-like URL parameters
(`token`, `key`, `secret`, `password`, `session`, `sig`, `auth`, …) are replaced; cookie values
and detected secrets are already masked by the security scanner. Website text and documents are
wrapped in escaped `<scan_findings>`/`<document>` blocks and declared untrusted data in the system
prompt; the grounding validator rejects AI text citing findings, URLs, numbers, colors or quotes
that are not in the evidence, and severity can move at most one level.

## 6. Troubleshooting

| `ai:check` / AI step says | Do this |
|---|---|
| `auth` — check GEMINI_API_KEY / GROQ_API_KEY | Re-copy the key; make sure it matches `AI_PROVIDER` |
| `not_found` — check AI_MODEL | Use a model id from the provider's model list |
| `bad_request` | For models without strict schemas set `AI_STRUCTURED_OUTPUT=json_object`; leave `AI_TEMPERATURE` empty |
| `too_large` | Lower `AI_MAX_INPUT_TOKENS` (and `AI_MAX_OUTPUT_TOKENS`) below the per-minute token limit |
| `rate_limit` | Set `AI_REQUESTS_PER_MINUTE` / `AI_TOKENS_PER_MINUTE` to your plan; lower `AI_CONCURRENCY` |
| `quota_exhausted` | Wait for the reset (Gemini: midnight Pacific), lower `AI_MAX_ISSUES_PER_SCAN`, or use a paid tier. Scans keep working without AI text |
| `invalid_output` / `truncated` | Try `json_object`, a larger `AI_MAX_OUTPUT_TOKENS`, or another model |

## 7. Tests

Mock tests (deterministic, no network): `packages/ai/src/free-tier.test.ts` (error shapes of
Gemini/Groq/OpenAI, retries with Retry-After/RetryInfo, quota vs rate limit, credentials, malformed
and truncated output, cancellation during backoff, pacing, oversize groups, secret scrubbing,
prompt-injection escaping, health check, configuration), `packages/ai/src/providers.test.ts`, and
the real-database integration test "free-tier provider (Gemini preset, mock endpoint)" in
`apps/worker/src/pipeline/issues.int.test.ts`.

**Live tests: none have been run** — no API key was configured in this installation. To verify a
real provider, set the variables above and run `npm run ai:check`, then a scan of the demo site
(`npm run demo:site`, project URL `http://localhost:4100`).
