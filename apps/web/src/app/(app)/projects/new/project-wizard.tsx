"use client";

import { CONTENT_ACCEPT, contentKindForFilename } from "@qa/core/content";
import { countSpecValues, emptyDesignSpec, type DesignSpec } from "@qa/core/design-spec";
import type { ScanDefaults, Viewport } from "@qa/core/domain";
import { parseFigmaUrl } from "@qa/core/figma";
import { Check, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DesignSpecEditor } from "@/components/references/design-spec-editor";
import { ProcessingStatus } from "@/components/references/processing-status";
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
import { ApiError, apiFetch, apiUpload } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { StartScan } from "../[id]/scan/start-scan";

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
  maxUploadMb: number;
}

interface PendingFile {
  id: number;
  file: File;
  targetPath: string;
}

let fileId = 0;

/** Validates a file on the client (the server validates again, including its content). */
function fileProblem(file: File, maxUploadMb: number): string | null {
  if (!contentKindForFilename(file.name))
    return `${file.name}: only PDF, DOCX, TXT and Markdown files are supported.`;
  if (file.size > maxUploadMb * 1024 * 1024) return `${file.name}: larger than ${maxUploadMb} MB.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}

interface Status {
  documents: Array<{
    id: string;
    filename: string;
    parseStatus: string;
    parseError: string | null;
  }>;
  draft: { version: number } | null;
  active: { version: number } | null;
}

/** Final step: live processing status of what was uploaded, then Start QA Scan. */
function Finish({
  projectId,
  name,
  websiteUrl,
  problems,
  expectReferences,
}: {
  projectId: string;
  name: string;
  websiteUrl: string;
  problems: string[];
  expectReferences: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!expectReferences) return;
    let stop = false;
    const load = async () => {
      try {
        const [docs, spec] = await Promise.all([
          apiFetch<{ items: Status["documents"] }>(
            `/api/v1/projects/${projectId}/content-documents`,
          ),
          apiFetch<{ draft: Status["draft"]; active: Status["active"] }>(
            `/api/v1/projects/${projectId}/design-spec`,
          ),
        ]);
        if (!stop) setStatus({ documents: docs.items, draft: spec.draft, active: spec.active });
      } catch {
        /* status is informational; the References page shows it too */
      }
    };
    void load();
    const t = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId, expectReferences]);
  const processing = status?.documents.some((d) => ["pending", "parsing"].includes(d.parseStatus));

  return (
    <div className="mt-5 space-y-5">
      <Alert tone="success">Project “{name}” was created and saved.</Alert>
      {problems.length > 0 && (
        <Alert tone="error">
          Some items could not be saved. Add them on the References page:
          <ul className="mt-1 list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {expectReferences && status && (
        <div className="space-y-2 rounded-md border border-border p-4 text-sm">
          <p className="font-medium">References</p>
          <p className="text-muted">
            {status.active
              ? `Design reference version ${status.active.version} is confirmed.`
              : status.draft
                ? "Values extracted from Figma or the guideline are waiting for your review on the References page; they are used only after you confirm them."
                : "No confirmed design reference yet (Figma links and guidelines are processed in the background)."}
          </p>
          {status.documents.length > 0 && (
            <ul className="space-y-1">
              {status.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all">{d.filename}</span>
                  <ProcessingStatus status={d.parseStatus} />
                  {d.parseError && (
                    <span className="w-full text-xs text-danger">{d.parseError}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {processing && (
            <p className="text-xs text-muted">
              Documents still processing are not included in a scan started now.
            </p>
          )}
          <Link href={`/projects/${projectId}/references`} className="text-primary hover:underline">
            Open References
          </Link>
        </div>
      )}
      <div className="rounded-md border border-border p-4">
        <StartScan projectId={projectId} websiteUrl={websiteUrl} />
      </div>
      <div className="flex gap-2">
        <ButtonLink href={`/projects/${projectId}`} variant="secondary">
          Open project
        </ButtonLink>
        <Link
          href="/projects"
          className="inline-flex items-center px-3 text-sm text-primary hover:underline"
        >
          All projects
        </Link>
      </div>
    </div>
  );
}

export function ProjectWizard({ defaults, scanners, maxUploadMb }: Props) {
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
  const [guideline, setGuideline] = useState<File | null>(null);
  const [manualSpec, setManualSpec] = useState<DesignSpec | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const guidelineInput = useRef<HTMLInputElement>(null);
  // Step 3
  const [contentFiles, setContentFiles] = useState<PendingFile[]>([]);
  const contentInput = useRef<HTMLInputElement>(null);
  // Step 4
  const [selectedScanners, setSelectedScanners] = useState<string[]>(defaults.scanners);
  const [viewports, setViewports] = useState<Viewport[]>(defaults.viewports);
  const [maxPages, setMaxPages] = useState(defaults.maxPages);
  const [maxDepth, setMaxDepth] = useState(defaults.maxDepth);
  const [respectRobots, setRespectRobots] = useState(defaults.respectRobots);
  const [auth, setAuth] = useState<SiteAuthDraft>(EMPTY_AUTH);
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({});

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [saveProblems, setSaveProblems] = useState<string[]>([]);

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
    const e: Record<string, string> = {};
    if (figmaUrl.trim()) {
      const r = parseFigmaUrl(figmaUrl);
      if (!r.ok) e.figmaUrl = r.message;
    }
    if (guideline) {
      const problem = fileProblem(guideline, maxUploadMb);
      if (problem) e.guideline = problem;
    }
    setErrors(e);
    if (!Object.keys(e).length) setStep(2);
  }

  function addContentFiles() {
    const files = [...(contentInput.current?.files ?? [])];
    const problems: string[] = [];
    const ok: PendingFile[] = [];
    for (const f of files) {
      const p = fileProblem(f, maxUploadMb);
      if (p) problems.push(p);
      else ok.push({ id: ++fileId, file: f, targetPath: "" });
    }
    setFileErrors(problems);
    setContentFiles((list) => [...list, ...ok]);
    if (contentInput.current) contentInput.current.value = "";
  }

  function nextFromContent() {
    const bad = contentFiles.find(
      (f) => f.targetPath.trim() && !/^\/\S*$/.test(f.targetPath.trim()),
    );
    if (bad)
      return setFileErrors([
        `${bad.file.name}: the page must be a site path starting with /, e.g. /about.`,
      ]);
    setFileErrors([]);
    setStep(3);
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
      // The project exists from here on; each follow-up item is saved independently.
      const problems: string[] = [];
      const message = (err: unknown) => (err instanceof ApiError ? err.message : "unknown error");
      const authPayload = toPayload(auth);
      if (authPayload)
        await apiFetch(`/api/v1/projects/${project.id}/scan-auth`, {
          method: "PUT",
          body: authPayload,
        }).catch((err) =>
          problems.push(`Site credentials: ${message(err)} (add them in project settings)`),
        );
      if (manualSpec)
        await apiFetch(`/api/v1/projects/${project.id}/design-spec`, {
          method: "PUT",
          body: manualSpec,
        }).catch((err) => problems.push(`Design values: ${message(err)}`));
      if (guideline)
        await apiUpload(`/api/v1/projects/${project.id}/guideline-documents`, guideline).catch(
          (err) => problems.push(`${guideline.name}: ${message(err)}`),
        );
      for (const f of contentFiles)
        await apiUpload(
          `/api/v1/projects/${project.id}/content-documents`,
          f.file,
          f.targetPath.trim() ? { targetPath: f.targetPath.trim() } : {},
        ).catch((err) => problems.push(`${f.file.name}: ${message(err)}`));
      setSaveProblems(problems);
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

  const brandSummary = [
    figmaUrl.trim() ? `Figma: ${figmaUrl.trim()}` : null,
    guideline ? `Guideline: ${guideline.name}` : null,
    manualSpec ? `${countSpecValues(manualSpec)} values entered manually` : null,
  ].filter(Boolean);

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

      <section
        className={cn(
          "min-w-0 rounded-lg border border-border bg-surface p-6",
          step === 1 && editorOpen ? "max-w-5xl" : "max-w-2xl",
        )}
      >
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
          <div className="mt-5 space-y-5">
            <p className="text-sm text-muted">
              The design the website should match. Use any combination: a Figma link, a brand
              guideline document, or values entered by hand. Extracted values are drafts you review
              before they are used; nothing is guessed. Everything is optional.
            </p>
            <Field
              label="Figma file link (optional)"
              hint="For example https://www.figma.com/design/<file-key>/<name>. Reading it needs a Figma access token (server or project setting)."
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
            <Field
              label="Brand guideline document (optional)"
              hint={`PDF, DOCX, TXT or Markdown, up to ${maxUploadMb} MB. Values written literally (e.g. “Primary — #1A56DB”) are read with citations.`}
              error={errors.guideline}
            >
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  ref={guidelineInput}
                  type="file"
                  accept={CONTENT_ACCEPT}
                  onChange={(e) => setGuideline(e.target.files?.[0] ?? null)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
                />
              )}
            </Field>
            <div className="rounded-md border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <span className="font-medium">Manual values</span>{" "}
                  <span className="text-muted">
                    {manualSpec ? `· ${countSpecValues(manualSpec)} values set` : "· none"}
                  </span>
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={editorOpen}
                  onClick={() => setEditorOpen((o) => !o)}
                >
                  {editorOpen ? "Close editor" : manualSpec ? "Edit values" : "Enter values"}
                </Button>
              </div>
              {editorOpen && (
                <div className="mt-4">
                  <DesignSpecEditor
                    initial={manualSpec ?? emptyDesignSpec()}
                    submitLabel="Use these values"
                    onSubmit={(spec) => {
                      setManualSpec(countSpecValues(spec) ? spec : null);
                      setEditorOpen(false);
                      toast.success(
                        countSpecValues(spec)
                          ? `${countSpecValues(spec)} design values will be saved with the project.`
                          : "No manual values set.",
                      );
                    }}
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={nextFromFigma}>
                {brandSummary.length ? "Continue" : "Skip for now"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-5 space-y-5">
            <p className="text-sm text-muted">
              Approved content documents (PDF, DOCX, TXT, Markdown) are compared with the text on
              the website. Optionally tell us which page a document describes; otherwise “Page: …”
              markers in the document or its headings are used.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Field
                label="Add documents"
                hint={`Up to ${maxUploadMb} MB each.`}
                className="min-w-64 flex-1"
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    ref={contentInput}
                    type="file"
                    multiple
                    accept={CONTENT_ACCEPT}
                    onChange={addContentFiles}
                    aria-describedby={describedBy}
                    className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium"
                  />
                )}
              </Field>
            </div>
            {contentFiles.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {contentFiles.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 break-all">
                      {f.file.name}{" "}
                      <span className="text-xs text-subtle">({formatBytes(f.file.size)})</span>
                    </span>
                    <input
                      aria-label={`Website page for ${f.file.name} (optional)`}
                      value={f.targetPath}
                      onChange={(e) =>
                        setContentFiles((list) =>
                          list.map((x) =>
                            x.id === f.id ? { ...x, targetPath: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="Page, e.g. /about"
                      className={cn(inputClasses, "h-8 w-40 px-2 font-mono text-sm")}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${f.file.name}`}
                      onClick={() => setContentFiles((list) => list.filter((x) => x.id !== f.id))}
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {fileErrors.length > 0 && (
              <Alert tone="error">
                <ul className="list-disc pl-4">
                  {fileErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button onClick={nextFromContent}>
                {contentFiles.length ? "Continue" : "Continue without content"}
              </Button>
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
              <p className="text-xs text-subtle">
                All six are enabled by default. Design and content comparisons run automatically
                when references exist.
              </p>
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
                [
                  "Figma / brand",
                  brandSummary.length
                    ? brandSummary.join(" · ")
                    : "None (design checks: unable to verify)",
                  1,
                ],
                [
                  "Content",
                  contentFiles.length
                    ? contentFiles
                        .map(
                          (f) =>
                            `${f.file.name}${f.targetPath.trim() ? ` → ${f.targetPath.trim()}` : ""}`,
                        )
                        .join(", ")
                    : "None (content checks: unable to verify)",
                  2,
                ],
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
          <Finish
            projectId={createdId}
            name={name.trim()}
            websiteUrl={websiteUrl ?? websiteInput}
            problems={saveProblems}
            expectReferences={Boolean(
              figmaUrl.trim() || guideline || manualSpec || contentFiles.length,
            )}
          />
        )}
      </section>
    </div>
  );
}
