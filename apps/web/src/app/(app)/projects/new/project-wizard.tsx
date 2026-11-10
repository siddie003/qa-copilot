"use client";

import { CONTENT_ACCEPT, contentKindForFilename } from "@qa/core/content";
import { countSpecValues, emptyDesignSpec, type DesignSpec } from "@qa/core/design-spec";
import type { ScanDefaults, Viewport } from "@qa/core/domain";
import { SOURCE_DESCRIPTIONS } from "@qa/core/explain";
import { parseFigmaUrl } from "@qa/core/figma";
import { FONT_ACCEPT, fontFormatForFilename, MAX_FONT_FILE_MB } from "@qa/core/fonts";
import { checkPageLink, pageLinkKey } from "@qa/core/page-links";
import { Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageLinksEditor, type PageLinkItem } from "@/components/projects/page-links-editor";
import { SelectedFiles, UploadList, type UploadItem } from "@/components/projects/selected-files";
import { DesignSpecEditor } from "@/components/references/design-spec-editor";
import { CoverageSummary, DocumentStatus } from "@/components/references/document-status";
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
import { ApiError, apiFetch, apiUploadWithProgress, describeApiError } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { StartScan } from "../[id]/scan/start-scan";
import { referencesNotReady } from "@/lib/scan-readiness";

const STEPS = ["Project", "Figma / brand", "Configure scan", "Review", "Start scan"] as const;

/** Server-side limits mirrored here so the form can say them up front. */
const MAX_GUIDELINES = 10;
const MAX_FONTS = 20;
const MAX_CONTENT = 50;

interface Props {
  defaults: ScanDefaults;
  scanners: Array<{ key: string; label: string }>;
  maxUploadMb: number;
  /** Server-side integration state, so the wizard can say what will and will not work. */
  integrations: { figmaServerToken: boolean; aiConfigured: boolean };
}

interface PendingFile {
  id: number;
  file: File;
  targetPath: string;
}

let fileId = 0;
let linkId = 0;

/** Host of a typed address (https:// assumed), or null when it is not a URL at all. */
function hostOf(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const isFigmaHost = (host: string | null) =>
  host !== null && (host === "figma.com" || host.endsWith(".figma.com"));

const FIGMA_IN_WEBSITE =
  "This is a Figma link. Enter the address of the live website to test here; you can add the Figma link in the next step.";

/** Validates a document on the client (the server validates again, including its content). */
function documentProblem(file: File, maxUploadMb: number): string | null {
  if (!contentKindForFilename(file.name))
    return `${file.name}: only PDF, DOCX, TXT and Markdown files are supported.`;
  if (file.size > maxUploadMb * 1024 * 1024) return `${file.name}: larger than ${maxUploadMb} MB.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}

function fontProblem(file: File, maxMb: number): string | null {
  if (!fontFormatForFilename(file.name))
    return `${file.name}: only font files in WOFF2, WOFF, TTF or OTF format are supported.`;
  if (file.size > maxMb * 1024 * 1024) return `${file.name}: larger than ${maxMb} MB.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}

const sameFile = (a: File, b: File) =>
  a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/**
 * Adds the chosen files to a list: invalid files and files already in the list are reported, the
 * rest are kept until the project is created.
 */
function pickFiles(
  input: HTMLInputElement | null,
  list: PendingFile[],
  max: number,
  problem: (f: File) => string | null,
): { added: PendingFile[]; problems: string[] } {
  const problems: string[] = [];
  const added: PendingFile[] = [];
  for (const f of [...(input?.files ?? [])]) {
    const p = problem(f);
    if (p) problems.push(p);
    else if ([...list, ...added].some((x) => sameFile(x.file, f)))
      problems.push(`${f.name}: this file is already in the list.`);
    else if (list.length + added.length >= max)
      problems.push(`${f.name}: at most ${max} files can be added.`);
    else added.push({ id: ++fileId, file: f, targetPath: "" });
  }
  if (input) input.value = "";
  return { added, problems };
}

const fileInputClasses =
  "block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium";

interface Status {
  documents: Array<{
    id: string;
    filename: string;
    parseStatus: string;
    parseError: string | null;
    stage: string | null;
    outcome: string | null;
    coverage: unknown;
    blockCount: number;
    chunkCount: number;
  }>;
  draft: { version: number } | null;
  active: { version: number } | null;
  references: Array<{
    id: string;
    kind: string;
    status: string;
    outcome?: string | null;
    error: string | null;
  }>;
}

/** Final step: uploads with real progress, processing status, then Start QA Scan. */
function Finish({
  projectId,
  name,
  websiteUrl,
  problems,
  expectReferences,
  uploads,
  onRetry,
}: {
  projectId: string;
  name: string;
  websiteUrl: string;
  problems: string[];
  expectReferences: boolean;
  uploads: UploadItem[];
  onRetry(id: number): void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  // Becomes true after the first status request, also when it failed (Start QA Scan is then
  // no longer held back by the reference check).
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!expectReferences) return;
    let stop = false;
    const load = async () => {
      try {
        const [docs, spec, refs] = await Promise.all([
          apiFetch<{ items: Status["documents"] }>(
            `/api/v1/projects/${projectId}/content-documents`,
          ),
          apiFetch<{ draft: Status["draft"]; active: Status["active"] }>(
            `/api/v1/projects/${projectId}/design-spec`,
          ),
          apiFetch<{ items: Status["references"] }>(`/api/v1/projects/${projectId}/references`),
        ]);
        if (!stop)
          setStatus({
            documents: docs.items,
            draft: spec.draft,
            active: spec.active,
            references: refs.items,
          });
      } catch {
        /* status is informational; the References page shows it too */
      } finally {
        if (!stop) setChecked(true);
      }
    };
    void load();
    const t = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId, expectReferences]);
  const processing =
    status?.documents.some((d) => ["pending", "parsing"].includes(d.parseStatus)) ||
    status?.references.some((r) => ["pending", "processing"].includes(r.status));
  const uploading = uploads.some((u) => u.status === "waiting" || u.status === "uploading");
  const failed = uploads.filter((u) => u.status === "failed");

  return (
    <div className="mt-5 space-y-5">
      <Alert tone="success">Project “{name}” was created and saved.</Alert>
      {problems.length > 0 && (
        <Alert tone="error">
          Some settings could not be saved. Add them in the project afterwards:
          <ul className="mt-1 list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {uploads.length > 0 && (
        <div className="space-y-2 rounded-md border border-border p-4 text-sm">
          <p className="font-medium">Files</p>
          <p className="text-xs text-muted" aria-live="polite">
            {uploading
              ? "Uploading your files. Keep this page open until they are uploaded."
              : failed.length
                ? `${failed.length} file${failed.length === 1 ? "" : "s"} could not be uploaded. Retry here, or add ${failed.length === 1 ? "it" : "them"} later on the References page.`
                : "All files were uploaded."}
          </p>
          <UploadList items={uploads} onRetry={onRetry} />
        </div>
      )}
      {expectReferences && status && (
        <div className="space-y-2 rounded-md border border-border p-4 text-sm">
          <p className="font-medium">References</p>
          <p className="text-muted">
            {status.active
              ? `Design reference version ${status.active.version} is confirmed.`
              : status.draft
                ? "Values extracted from Figma or the brand guideline are waiting for your review on the References page; they are used only after you confirm them."
                : "No confirmed design reference yet."}
          </p>
          {status.references.length > 0 && (
            <ul className="space-y-1">
              {status.references.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{r.kind === "figma" ? "Figma file" : "Brand guideline"}</span>
                  <ProcessingStatus status={r.status} outcome={r.outcome} />
                  {r.error && (
                    <span
                      className={cn(
                        "w-full text-xs",
                        r.status === "failed" ? "text-danger" : "text-muted",
                      )}
                    >
                      {r.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status.documents.length > 0 && (
            <ul className="space-y-1">
              {status.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all">{d.filename}</span>
                  <DocumentStatus doc={d} />
                  <span className="w-full">
                    <CoverageSummary doc={d} />
                  </span>
                  {d.parseError && (
                    <span className="w-full text-xs text-danger">{d.parseError}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(processing || uploading) && (
            <p className="text-xs text-muted">
              Files still uploading or processing are not included in a scan started now.
            </p>
          )}
          <Link href={`/projects/${projectId}/references`} className="text-primary hover:underline">
            Open References
          </Link>
        </div>
      )}
      <div className="rounded-md border border-border p-4">
        <StartScan
          projectId={projectId}
          websiteUrl={websiteUrl}
          checking={expectReferences && !checked}
          notReady={
            status
              ? referencesNotReady({
                  designConfirmed: Boolean(status.active),
                  designDraft: Boolean(status.draft),
                  designProcessing: status.references.filter((r) =>
                    ["pending", "processing"].includes(r.status),
                  ).length,
                  documentsProcessing: status.documents.filter((d) =>
                    ["pending", "parsing"].includes(d.parseStatus),
                  ).length,
                })
              : []
          }
        />
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

const UPLOAD_PATH: Record<UploadItem["kind"], string> = {
  guideline: "guideline-documents",
  font: "fonts",
  content: "content-documents",
};

export function ProjectWizard({ defaults, scanners, maxUploadMb, integrations }: Props) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const maxFontMb = Math.min(MAX_FONT_FILE_MB, maxUploadMb);

  // Step 1: project, brand guidelines, font files
  const [name, setName] = useState("");
  const [websiteInput, setWebsiteInput] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  const [guidelines, setGuidelines] = useState<PendingFile[]>([]);
  const [fonts, setFonts] = useState<PendingFile[]>([]);
  const guidelineInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const [guidelineErrors, setGuidelineErrors] = useState<string[]>([]);
  const [fontErrors, setFontErrors] = useState<string[]>([]);
  // Step 2: Figma / brand: Figma link, manual values, content documents, page links
  const [figmaUrl, setFigmaUrl] = useState("");
  const [manualSpec, setManualSpec] = useState<DesignSpec | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [contentFiles, setContentFiles] = useState<PendingFile[]>([]);
  const contentInput = useRef<HTMLInputElement>(null);
  const [contentErrors, setContentErrors] = useState<string[]>([]);
  const [pageLinks, setPageLinks] = useState<PageLinkItem[]>([]);
  const [droppedLinks, setDroppedLinks] = useState<string[]>([]);
  // Step 3: configure scan
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
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);

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
    else if (isFigmaHost(hostOf(websiteInput))) e.websiteUrl = FIGMA_IN_WEBSITE;
    setErrors(e);
    if (Object.keys(e).length) return;
    setPending(true);
    try {
      const r = await apiFetch<{ url: string }>("/api/v1/projects/validate-url", {
        method: "POST",
        body: { websiteUrl: websiteInput },
      });
      setWebsiteUrl(r.url);
      // Page links added earlier must belong to the (possibly changed) website.
      const kept = pageLinks.filter((l) => checkPageLink(l.url, r.url).ok);
      setDroppedLinks(pageLinks.filter((l) => !kept.includes(l)).map((l) => l.url));
      setPageLinks(kept);
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
      if (!r.ok)
        e.figmaUrl = isFigmaHost(hostOf(figmaUrl))
          ? r.message
          : "This is not a Figma link. Figma file links start with https://www.figma.com/design/… (the website address belongs in step 1).";
    }
    const bad = contentFiles.find(
      (f) => f.targetPath.trim() && !/^\/\S*$/.test(f.targetPath.trim()),
    );
    if (bad)
      setContentErrors([
        `${bad.file.name}: the page must be a site path starting with /, e.g. /about.`,
      ]);
    setErrors(e);
    if (!Object.keys(e).length && !bad) {
      setContentErrors([]);
      setStep(2);
    }
  }

  function addPageLink(raw: string): string | null {
    const site = websiteUrl ?? "";
    const r = checkPageLink(raw, site);
    if (!r.ok) return r.message;
    const key = pageLinkKey(r.url);
    const dup = pageLinks.find((l) => pageLinkKey(l.url) === key);
    if (dup) return `${dup.path} is already in the list.`;
    setPageLinks((list) => [...list, { id: String(++linkId), url: r.url, path: r.path }]);
    return null;
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
    if (!Object.keys(e).length) setStep(3);
  }

  const patchUpload = (id: number, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));

  /** Uploads one file to the created project; the item shows real progress and the outcome. */
  async function upload(projectId: string, item: UploadItem) {
    patchUpload(item.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const res = await apiUploadWithProgress<{ family?: string | null; style?: string | null }>(
        `/api/v1/projects/${projectId}/${UPLOAD_PATH[item.kind]}`,
        item.file,
        item.targetPath ? { targetPath: item.targetPath } : {},
        (progress) => patchUpload(item.id, { progress }),
      );
      patchUpload(item.id, {
        status: "done",
        progress: 1,
        note:
          item.kind === "font"
            ? `Font file read: “${res.family ?? "unnamed family"}”${res.style ? ` ${res.style}` : ""}. Whether the website uses it is checked by the Design Quality & Typography scanner.`
            : item.kind === "guideline"
              ? "Uploaded. Values found in it are a draft until you confirm them on the References page."
              : "Uploaded. Its text is extracted in the background.",
      });
    } catch (err) {
      patchUpload(item.id, {
        status: "failed",
        error: err instanceof ApiError ? err.message : "The upload failed.",
      });
    }
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
          ...(pageLinks.length ? { pageLinks: pageLinks.map((l) => l.url) } : {}),
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
        }).catch((err) =>
          problems.push(`Design values: ${message(err)} (enter them on the References page)`),
        );
      setSaveProblems(problems);
      const queue: UploadItem[] = [
        ...guidelines.map((f) => ({ kind: "guideline" as const, f })),
        ...fonts.map((f) => ({ kind: "font" as const, f })),
        ...contentFiles.map((f) => ({ kind: "content" as const, f })),
      ].map(({ kind, f }) => ({
        id: f.id,
        kind,
        file: f.file,
        ...(kind === "content" && f.targetPath.trim() ? { targetPath: f.targetPath.trim() } : {}),
        status: "waiting" as const,
        progress: 0,
      }));
      setUploads(queue);
      setStep(4);
      for (const item of queue) await upload(project.id, item);
    } catch (err) {
      // Nothing was created: every entry and selected file stays in the form for another try.
      const message = describeApiError(err, "Project could not be created.");
      setErrors({
        form: `${message} Your entries and files are kept; correct the problem and try again.`,
      });
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
    manualSpec ? `${countSpecValues(manualSpec)} values entered manually` : null,
  ].filter(Boolean);
  const site = websiteUrl ?? websiteInput;
  const pagePaths = pageLinks.map((l) => l.path);

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
              hint="The live website to test, for example https://www.example.com. Scanning starts at this address (https:// is added if omitted). Figma files and content documents are added in the next step. Only scan sites you are authorized to test."
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
            <div className="space-y-2">
              <Field
                label="Brand guidelines (optional)"
                hint={`Documents with your brand rules: colors, typography, heading styles, spacing, components. PDF, DOCX, TXT or Markdown, up to ${maxUploadMb} MB each, at most ${MAX_GUIDELINES}. Only values written literally (e.g. “H1 — 48px”, “Primary — #1A56DB”) are read, with citations, and you confirm them before they are used. Page text belongs in content documents (next step).`}
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    ref={guidelineInput}
                    type="file"
                    multiple
                    accept={CONTENT_ACCEPT}
                    onChange={() => {
                      const r = pickFiles(guidelineInput.current, guidelines, MAX_GUIDELINES, (f) =>
                        documentProblem(f, maxUploadMb),
                      );
                      setGuidelineErrors(r.problems);
                      setGuidelines((list) => [...list, ...r.added]);
                    }}
                    aria-describedby={describedBy}
                    className={fileInputClasses}
                  />
                )}
              </Field>
              <SelectedFiles
                label="Selected brand guidelines"
                files={guidelines}
                onRemove={(id) => setGuidelines((l) => l.filter((x) => x.id !== id))}
              />
              {guidelineErrors.length > 0 && (
                <Alert tone="error">
                  <ul className="list-disc pl-4">
                    {guidelineErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
            <div className="space-y-2">
              <Field
                label="Font files (optional)"
                hint={`The font files of your brand: WOFF2, WOFF, TTF or OTF, up to ${maxFontMb} MB each, at most ${MAX_FONTS}. The font names are read from the files when they are uploaded; scans then check whether the website's headings and text use and actually render these fonts. Fonts are stored privately for this project and are never added to the website.`}
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    ref={fontInput}
                    type="file"
                    multiple
                    accept={FONT_ACCEPT}
                    onChange={() => {
                      const r = pickFiles(fontInput.current, fonts, MAX_FONTS, (f) =>
                        fontProblem(f, maxFontMb),
                      );
                      setFontErrors(r.problems);
                      setFonts((list) => [...list, ...r.added]);
                    }}
                    aria-describedby={describedBy}
                    className={fileInputClasses}
                  />
                )}
              </Field>
              <SelectedFiles
                label="Selected font files"
                files={fonts}
                onRemove={(id) => setFonts((l) => l.filter((x) => x.id !== id))}
              />
              {fontErrors.length > 0 && (
                <Alert tone="error">
                  <ul className="list-disc pl-4">
                    {fontErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
            {(guidelines.length > 0 || fonts.length > 0) && (
              <p className="text-xs text-muted">
                Selected files are uploaded when you create the project (step 4); until then they
                are not checked by the server. If creating the project fails, they stay selected.
              </p>
            )}
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
          <div className="mt-5 space-y-6">
            <p className="text-sm text-muted">
              The design the website should match, the text it should contain and the pages that
              matter most. Everything here is optional; without a design reference or approved
              content, those comparisons are reported as not run.
            </p>
            {droppedLinks.length > 0 && (
              <Alert tone="warning">
                The website URL changed, so these page links no longer belong to it and were
                removed: {droppedLinks.join(", ")}
              </Alert>
            )}
            <Field
              label="Figma design URL (optional)"
              hint="The design file, for example https://www.figma.com/design/<file-key>/<name>. Not the website address."
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
            {parseFigmaUrl(figmaUrl).ok && !integrations.figmaServerToken && (
              <Alert tone="warning">
                No Figma access token is configured on this server. The link will be saved, but the
                design cannot be read until you add a token on the project&apos;s References page
                after it is created (or an administrator sets FIGMA_ACCESS_TOKEN). The References
                page then shows the reading progress.
              </Alert>
            )}
            <div className="rounded-md border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  <span className="font-medium">Design values entered by hand (optional)</span>{" "}
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

            <fieldset className="space-y-3 rounded-md border border-border p-4">
              <legend className="px-1 text-sm font-medium">Content documents (optional)</legend>
              <p className="text-xs text-muted">
                What the website should <em>say</em>: documents with the approved page text, such as
                a copy deck signed off by marketing or legal. Their text is compared with the text
                on the website. Optionally say which page a document describes; otherwise “Page: …”
                markers in the document or its headings are used. PDF, DOCX, TXT or Markdown, up to{" "}
                {maxUploadMb} MB each.
              </p>
              <Field label="Add documents">
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    ref={contentInput}
                    type="file"
                    multiple
                    accept={CONTENT_ACCEPT}
                    onChange={() => {
                      const r = pickFiles(contentInput.current, contentFiles, MAX_CONTENT, (f) =>
                        documentProblem(f, maxUploadMb),
                      );
                      setContentErrors(r.problems);
                      setContentFiles((list) => [...list, ...r.added]);
                    }}
                    aria-describedby={describedBy}
                    className={fileInputClasses}
                  />
                )}
              </Field>
              <datalist id="wizard-page-paths">
                {pagePaths.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <SelectedFiles
                label="Selected content documents"
                files={contentFiles}
                onRemove={(id) => setContentFiles((l) => l.filter((x) => x.id !== id))}
              >
                {(id) => {
                  const f = contentFiles.find((x) => x.id === id)!;
                  return (
                    <input
                      aria-label={`Website page for ${f.file.name} (optional)`}
                      value={f.targetPath}
                      list="wizard-page-paths"
                      onChange={(e) =>
                        setContentFiles((list) =>
                          list.map((x) => (x.id === id ? { ...x, targetPath: e.target.value } : x)),
                        )
                      }
                      placeholder="Page, e.g. /about"
                      className={cn(inputClasses, "h-8 w-40 px-2 font-mono text-sm")}
                    />
                  );
                }}
              </SelectedFiles>
              {contentErrors.length > 0 && (
                <Alert tone="error">
                  <ul className="list-disc pl-4">
                    {contentErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </fieldset>

            <fieldset className="space-y-3 rounded-md border border-border p-4">
              <legend className="px-1 text-sm font-medium">Page links (optional)</legend>
              <p className="text-xs text-muted">
                Pages you want checked in every scan, even if no link leads to them. They are
                scanned in addition to the pages found by following links, and a page that cannot be
                loaded is reported with its error. Pages are not matched to Figma frames
                automatically.
              </p>
              <PageLinksEditor
                websiteUrl={site}
                links={pageLinks}
                onAdd={addPageLink}
                onRemove={(l) => setPageLinks((list) => list.filter((x) => x.id !== l.id))}
              />
            </fieldset>

            <div className="flex gap-2">
              <Button onClick={nextFromFigma}>
                {brandSummary.length || contentFiles.length || pageLinks.length
                  ? "Continue"
                  : "Skip for now"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(0)}>
                Back
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
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
                All scanners are enabled by default. Design and content comparisons run
                automatically when a confirmed design reference or processed approved content
                exists; Design Quality &amp; Typography uses them, and your font files, when they
                are available.
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {scanners.map((s) => (
                  <label key={s.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedScanners.includes(s.key)}
                      onChange={(e) =>
                        setSelectedScanners((v) =>
                          e.target.checked ? [...v, s.key] : v.filter((k) => k !== s.key),
                        )
                      }
                      className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span>
                      <span className="font-medium">{s.label}</span>
                      {SOURCE_DESCRIPTIONS[s.key] && (
                        <span className="block text-xs text-muted">
                          {SOURCE_DESCRIPTIONS[s.key]}
                        </span>
                      )}
                    </span>
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
              <Field
                label="Maximum pages"
                hint={`1–500${pageLinks.length ? `; your ${pageLinks.length} page link${pageLinks.length === 1 ? " is" : "s are"} scanned in addition` : ""}`}
                error={errors.maxPages}
              >
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
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div className="mt-5 space-y-5">
            <dl className="divide-y divide-border rounded-md border border-border text-sm">
              {[
                ["Project", name.trim(), 0],
                ["Website", site, 0],
                [
                  "Brand guidelines",
                  guidelines.length ? guidelines.map((f) => f.file.name).join(", ") : "None",
                  0,
                ],
                [
                  "Font files",
                  fonts.length
                    ? fonts.map((f) => f.file.name).join(", ")
                    : "None (fonts are checked for rendering only)",
                  0,
                ],
                [
                  "Figma / brand",
                  brandSummary.length
                    ? brandSummary.join(" · ")
                    : guidelines.length
                      ? "Brand guidelines only (values become a reference after you confirm them)"
                      : "None (design comparison will not run)",
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
                    : "None (content comparison will not run)",
                  1,
                ],
                [
                  "Page links",
                  pageLinks.length
                    ? pagePaths.join(", ")
                    : "None (the scan follows links from the website URL)",
                  1,
                ],
                [
                  "Scanners",
                  scanners
                    .filter((s) => selectedScanners.includes(s.key))
                    .map((s) => s.label)
                    .join(", "),
                  2,
                ],
                [
                  "Viewports",
                  viewports.map((v) => `${v.name} ${v.width}×${v.height}`).join(", "),
                  2,
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
                  2,
                ],
                [
                  "Crawl limits",
                  `${maxPages} pages, depth ${maxDepth}, robots.txt ${respectRobots ? "respected" : "ignored"}${pageLinks.length ? `, plus ${pageLinks.length} page link${pageLinks.length === 1 ? "" : "s"}` : ""}`,
                  2,
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
            <ul className="space-y-1 rounded-md bg-surface-muted px-4 py-3 text-sm">
              {figmaUrl.trim() && (
                <li>
                  <span className="font-medium">Figma:</span>{" "}
                  {integrations.figmaServerToken
                    ? "read in the background after the project is created; the values are a draft until you confirm them on the References page."
                    : "saved, but not read until a Figma access token is added on the project's References page."}
                </li>
              )}
              {selectedScanners.includes("design_quality") && (
                <li>
                  <span className="font-medium">Design Quality &amp; Typography:</span>{" "}
                  {guidelines.length ||
                  figmaUrl.trim() ||
                  manualSpec ||
                  fonts.length ||
                  contentFiles.length
                    ? "uses the confirmed design reference, your font files and the approved content where they are available; anything missing is reported as not configured, never guessed."
                    : "no references were added, so it checks consistency (headings, fonts, images, spacing) only; heading sizes are not compared with expected values."}
                </li>
              )}
              <li>
                <span className="font-medium">Issue explanations:</span>{" "}
                {integrations.aiConfigured
                  ? "written by AI from the scan evidence and checked against it; every issue also has a built-in plain-language explanation."
                  : "AI is not configured, so issues use the scanners' wording plus built-in plain-language explanations."}
              </li>
            </ul>
            <div className="flex gap-2">
              <Button onClick={create} disabled={pending}>
                {pending ? "Creating…" : "Create project"}
              </Button>
              <Button variant="secondary" onClick={() => setStep(2)} disabled={pending}>
                Back
              </Button>
            </div>
          </div>
        )}

        {step === 4 && createdId && (
          <Finish
            projectId={createdId}
            name={name.trim()}
            websiteUrl={site}
            problems={saveProblems}
            expectReferences={Boolean(
              figmaUrl.trim() || guidelines.length || manualSpec || contentFiles.length,
            )}
            uploads={uploads}
            onRetry={(id) => {
              const item = uploads.find((u) => u.id === id);
              if (item) void upload(createdId, item);
            }}
          />
        )}
      </section>
    </div>
  );
}
