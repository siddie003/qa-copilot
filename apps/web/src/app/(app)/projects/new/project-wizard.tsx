"use client";

import type { ScanDefaults, Viewport } from "@qa/core/domain";
import { parseFigmaUrl } from "@qa/core/figma";
import { Check, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import {
  EMPTY_AUTH,
  SiteAuthFields,
  toPayload,
  type SiteAuthDraft,
} from "@/components/projects/site-auth-fields";
import { Field, inputClasses } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/cn";

const STEPS = [
  "Project",
  "Figma / brand",
  "Content",
  "Configure scan",
  "Review",
  "Start scan",
] as const;

interface Props {
  defaults: ScanDefaults;
  scanners: Array<{ key: string; label: string }>;
}

export function ProjectWizard({ defaults, scanners }: Props) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Step 1
  const [name, setName] = useState("");
  const [websiteInput, setWebsiteInput] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  // Step 2
  const [figmaUrl, setFigmaUrl] = useState("");
  // Step 4
  const [selectedScanners, setSelectedScanners] = useState<string[]>(defaults.scanners);
  const [viewports, setViewports] = useState<Viewport[]>(defaults.viewports);
  const [maxPages, setMaxPages] = useState(defaults.maxPages);
  const [maxDepth, setMaxDepth] = useState(defaults.maxDepth);
  const [respectRobots, setRespectRobots] = useState(defaults.respectRobots);
  const [auth, setAuth] = useState<SiteAuthDraft>(EMPTY_AUTH);
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({});

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Move focus to the step heading so keyboard and screen-reader users land on the new step.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  async function nextFromProject() {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Enter a project name.";
    if (!websiteInput.trim()) e.websiteUrl = "Enter the website URL.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setPending(true);
    try {
      const r = await apiFetch<{ url: string }>("/api/v1/projects/validate-url", {
        method: "POST",
        body: { websiteUrl: websiteInput },
      });
      setWebsiteUrl(r.url);
      setStep(1);
    } catch (err) {
      setErrors(
        err instanceof ApiError && err.fieldErrors.websiteUrl
          ? { websiteUrl: err.fieldErrors.websiteUrl }
          : { form: err instanceof Error ? err.message : "URL could not be checked." },
      );
    } finally {
      setPending(false);
    }
  }

  function nextFromFigma() {
    if (figmaUrl.trim()) {
      const r = parseFigmaUrl(figmaUrl);
      if (!r.ok) return setErrors({ figmaUrl: r.message });
    }
    setErrors({});
    setStep(2);
  }

  function nextFromConfig() {
    const e: Record<string, string> = {};
    if (!selectedScanners.length) e.scanners = "Select at least one scanner.";
    if (!viewports.length) e.viewports = "Select at least one viewport.";
    if (!(maxPages >= 1 && maxPages <= 500)) e.maxPages = "Enter a number from 1 to 500.";
    if (!(maxDepth >= 0 && maxDepth <= 10)) e.maxDepth = "Enter a number from 0 to 10.";
    const a: Record<string, string> = {};
    if (auth.type === "basic") {
      if (!auth.username.trim()) a.username = "Enter the username.";
      if (!auth.password) a.password = "Enter the password.";
    }
    if (auth.type === "header") {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(auth.name.trim()))
        a.name = "Use letters, digits and dashes.";
      if (!auth.value) a.value = "Enter the header value.";
    }
    if (auth.type === "cookies" && !/^\s*[^=;\s]+=/.test(auth.cookies))
      a.cookies = 'Use the format "name=value; name2=value2".';
    setAuthErrors(a);
    if (Object.keys(a).length) e.auth = "invalid";
    setErrors(e);
    if (!Object.keys(e).length) setStep(4);
  }

  async function create() {
    setPending(true);
    setErrors({});
    try {
      const project = await apiFetch<{ id: string }>("/api/v1/projects", {
        method: "POST",
        body: {
          name,
          websiteUrl: websiteUrl ?? websiteInput,
          ...(figmaUrl.trim() ? { figmaUrl } : {}),
          scanDefaults: {
            scanners: selectedScanners,
            viewports,
            maxPages,
            maxDepth,
            respectRobots,
          },
        },
      });
      setCreatedId(project.id);
      toast.success(`Project “${name.trim()}” created.`);
      const authPayload = toPayload(auth);
      if (authPayload) {
        try {
          await apiFetch(`/api/v1/projects/${project.id}/scan-auth`, {
            method: "PUT",
            body: authPayload,
          });
        } catch (err) {
          toast.error(
            `The project was created, but the site credentials were not saved: ${
              err instanceof ApiError ? err.message : "unknown error"
            }. Add them in project settings.`,
          );
        }
      }
      setStep(5);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Project could not be created.";
      setErrors({ form: message });
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  const toggleViewport = (v: Viewport) =>
    setViewports((vs) =>
      vs.some((x) => x.name === v.name)
        ? vs.filter((x) => x.name !== v.name)
        : defaults.viewports.filter((d) => d.name === v.name || vs.some((x) => x.name === d.name)),
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
      <ol
        aria-label="Setup steps"
        tabIndex={0}
        className="flex min-w-0 gap-2 overflow-x-auto lg:flex-col lg:gap-1"
      >
        {STEPS.map((label, i) => {
          const done = i < step;
          return (
            <li
              key={label}
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm",
                i === step ? "bg-surface font-semibold shadow-sm ring-1 ring-border" : "text-muted",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                  done
                    ? "bg-success text-white"
                    : i === step
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-muted",
                )}
              >
                {done ? <Check className="size-3.5" /> : i + 1}
              </span>
              {label}
              {done && <span className="sr-only">(completed)</span>}
            </li>
          );
        })}
      </ol>

      <section className="min-w-0 max-w-2xl rounded-lg border border-border bg-surface p-6">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </h2>
        {errors.form && (
          <Alert tone="error" className="mt-4">
            {errors.form}
          </Alert>
        )}

        {step === 0 && (
          <form
            className="mt-5 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void nextFromProject();
            }}
          >
            <Field label="Project name" error={errors.name}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                  placeholder="Acme marketing site"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={inputClasses}
                />
              )}
            </Field>
            <Field
              label="Website URL"
              hint="Crawling starts here. https:// is added if omitted. Only scan sites you are authorized to test."
              error={errors.websiteUrl}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  value={websiteInput}
                  onChange={(e) => {
                    setWebsiteInput(e.target.value);
                    setWebsiteUrl(null);
                  }}
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://example.com"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={inputClasses}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Checking URL…" : "Continue"}
              </Button>
              <ButtonLink href="/projects" variant="secondary">
                Cancel
              </ButtonLink>
            </div>
          </form>
        )}

        {step === 1 && (
          <form
            className="mt-5 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              nextFromFigma();
            }}
          >
            <p className="text-sm text-muted">
              Link the Figma file the website was built from. Design values are extracted from it in
              a later step; nothing is guessed. You can skip this and add it later.
            </p>
            <Field
              label="Figma file link (optional)"
              hint="For example https://www.figma.com/design/<file-key>/<name>"
              error={errors.figmaUrl}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  inputMode="url"
                  placeholder="https://www.figma.com/design/…"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={inputClasses}
                />
              )}
            </Field>
            <Alert tone="info">
              Manual brand values and guideline document uploads, plus reading values from Figma,
              are added in Phase 6. Until then, design comparison is reported as “Unable to verify”.
            </Alert>
            <div className="flex gap-2">
              <Button type="submit">{figmaUrl.trim() ? "Continue" : "Skip for now"}</Button>
              <Button variant="secondary" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div className="mt-5 space-y-5">
            <p className="text-sm text-muted">
              Approved content documents (PDF, DOCX, TXT, Markdown) are compared against the text on
              the website.
            </p>
            <Alert tone="info">
              Document upload and content extraction are not available yet (Phase 6). Without
              approved content, content checks are reported as “Unable to verify”.
            </Alert>
            <div className="flex gap-2">
              <Button onClick={() => setStep(3)}>Continue without content</Button>
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <form
            className="mt-5 space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              nextFromConfig();
            }}
          >
            <fieldset>
              <legend className="text-sm font-medium">Scanners</legend>
              <p className="text-xs text-subtle">All six are enabled by default.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {scanners.map((s) => (
                  <label key={s.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedScanners.includes(s.key)}
                      onChange={(e) =>
                        setSelectedScanners((v) =>
                          e.target.checked ? [...v, s.key] : v.filter((k) => k !== s.key),
                        )
                      }
                      className="size-4 accent-[var(--primary)]"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              {errors.scanners && (
                <p className="mt-1 text-xs font-medium text-danger">{errors.scanners}</p>
              )}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Viewports</legend>
              <p className="text-xs text-subtle">Custom sizes can be added in project settings.</p>
              <div className="mt-2 flex flex-wrap gap-4">
                {defaults.viewports.map((v) => (
                  <label key={v.name} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={viewports.some((x) => x.name === v.name)}
                      onChange={() => toggleViewport(v)}
                      className="size-4 accent-[var(--primary)]"
                    />
                    <span className="capitalize">{v.name}</span>
                    <span className="text-subtle">
                      {v.width}×{v.height}
                    </span>
                  </label>
                ))}
              </div>
              {errors.viewports && (
                <p className="mt-1 text-xs font-medium text-danger">{errors.viewports}</p>
              )}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Maximum pages" hint="1–500" error={errors.maxPages}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="number"
                    min={1}
                    max={500}
                    value={maxPages}
                    onChange={(e) => setMaxPages(Number(e.target.value))}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    className={inputClasses}
                  />
                )}
              </Field>
              <Field
                label="Maximum link depth"
                hint="0–10 (0 = start page only)"
                error={errors.maxDepth}
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="number"
                    min={0}
                    max={10}
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(Number(e.target.value))}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    className={inputClasses}
                  />
                )}
              </Field>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={respectRobots}
                onChange={(e) => setRespectRobots(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span>
                Respect robots.txt
                <span className="block text-xs text-subtle">
                  Turn off only for sites you are authorized to test fully.
                </span>
              </span>
            </label>
            <fieldset className="rounded-md border border-border p-4">
              <legend className="px-1 text-sm font-medium">Site authentication (optional)</legend>
              <SiteAuthFields value={auth} onChange={setAuth} errors={authErrors} />
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit">Continue</Button>
              <Button variant="secondary" onClick={() => setStep(2)}>
                Back
              </Button>
            </div>
          </form>
        )}

        {step === 4 && (
          <div className="mt-5 space-y-5">
            <dl className="divide-y divide-border rounded-md border border-border text-sm">
              {[
                ["Project", name.trim(), 0],
                ["Website", websiteUrl ?? websiteInput, 0],
                ["Figma / brand", figmaUrl.trim() || "None (design checks: unable to verify)", 1],
                ["Content", "None (content checks: unable to verify)", 2],
                [
                  "Scanners",
                  scanners
                    .filter((s) => selectedScanners.includes(s.key))
                    .map((s) => s.label)
                    .join(", "),
                  3,
                ],
                [
                  "Viewports",
                  viewports.map((v) => `${v.name} ${v.width}×${v.height}`).join(", "),
                  3,
                ],
                [
                  "Site authentication",
                  auth.type === "none"
                    ? "None (public pages only)"
                    : auth.type === "basic"
                      ? `HTTP Basic as “${auth.username}”`
                      : auth.type === "header"
                        ? `Header “${auth.name}”`
                        : "Session cookies",
                  3,
                ],
                [
                  "Crawl limits",
                  `${maxPages} pages, depth ${maxDepth}, robots.txt ${respectRobots ? "respected" : "ignored"}`,
                  3,
                ],
              ].map(([label, value, target]) => (
                <div
                  key={label as string}
                  className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr_auto] sm:items-center"
                >
                  <dt className="font-medium">{label}</dt>
                  <dd className="break-all text-muted">{value}</dd>
                  <dd>
                    <button
                      type="button"
                      onClick={() => setStep(target as number)}
                      className="text-sm text-primary hover:underline"
                    >
                      Edit<span className="sr-only"> {label}</span>
                    </button>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex gap-2">
              <Button onClick={create} disabled={pending}>
                {pending ? "Creating…" : "Create project"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(3)} disabled={pending}>
                Back
              </Button>
            </div>
          </div>
        )}

        {step === 5 && createdId && (
          <div className="mt-5 space-y-5">
            <Alert tone="success">Project “{name.trim()}” was created and saved.</Alert>
            <div className="rounded-md border border-border p-4">
              <Button disabled aria-describedby="wizard-scan-note">
                <Play aria-hidden className="size-4" />
                Start QA Scan
              </Button>
              <p id="wizard-scan-note" className="mt-2 text-sm text-muted">
                Scanning is not available yet. The crawler, browser automation and scanners are
                built in Phases 4–5; this button is disabled rather than simulated.
              </p>
            </div>
            <div className="flex gap-2">
              <ButtonLink href={`/projects/${createdId}`}>Open project</ButtonLink>
              <Link
                href="/projects"
                className="inline-flex items-center px-3 text-sm text-primary hover:underline"
              >
                All projects
              </Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
