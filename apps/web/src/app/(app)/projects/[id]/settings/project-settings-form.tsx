"use client";

import { SOURCE_DESCRIPTIONS } from "@qa/core/explain";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, inputClasses } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

interface Viewport {
  name: string;
  width: number;
  height: number;
}

interface Props {
  project: {
    id: string;
    name: string;
    websiteUrl: string;
    scanDefaults: {
      scanners: string[];
      viewports: Viewport[];
      maxPages: number;
      maxDepth: number;
      respectRobots: boolean;
    };
  };
  scanners: Array<{ key: string; label: string }>;
}

export function ProjectSettingsForm({ project, scanners }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [viewports, setViewports] = useState<Viewport[]>(project.scanDefaults.viewports);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const updateViewport = (i: number, patch: Partial<Viewport>) =>
    setViewports((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setStatus(null);
    setFieldErrors({});
    try {
      await apiFetch(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        body: {
          name: form.get("name"),
          websiteUrl: form.get("websiteUrl"),
          scanDefaults: {
            scanners: form.getAll("scanners"),
            viewports,
            maxPages: Number(form.get("maxPages")),
            maxDepth: Number(form.get("maxDepth")),
            respectRobots: form.get("respectRobots") === "on",
          },
        },
      });
      setStatus({ tone: "success", text: "Settings saved." });
      toast.success("Project settings saved.");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setStatus({ tone: "error", text: err.message });
      } else setStatus({ tone: "error", text: "Settings could not be saved." });
    } finally {
      setPending(false);
    }
  }

  const err = (path: string) => fieldErrors[path];

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <section className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">General</h2>
        <Field label="Project name" error={err("name")}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="name"
              defaultValue={project.name}
              required
              maxLength={120}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
        <Field label="Website URL" error={err("websiteUrl")}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="websiteUrl"
              defaultValue={project.websiteUrl}
              required
              inputMode="url"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">Default scan configuration</h2>
        <fieldset>
          <legend className="text-sm font-medium">Scanners</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {scanners.map((s) => (
              <label key={s.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  name="scanners"
                  value={s.key}
                  defaultChecked={project.scanDefaults.scanners.includes(s.key)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                />
                <span>
                  <span className="font-medium">{s.label}</span>
                  {SOURCE_DESCRIPTIONS[s.key] && (
                    <span className="block text-xs text-muted">{SOURCE_DESCRIPTIONS[s.key]}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {err("scanDefaults.scanners") && (
            <p className="mt-1 text-xs font-medium text-danger">{err("scanDefaults.scanners")}</p>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">Viewports</legend>
          <div className="mt-2 space-y-2">
            {viewports.map((v, i) => (
              <div key={i} className="grid grid-cols-[1fr_5.5rem_5.5rem_auto] items-center gap-2">
                <input
                  aria-label={`Viewport ${i + 1} name`}
                  value={v.name}
                  onChange={(e) => updateViewport(i, { name: e.target.value })}
                  className={inputClasses}
                />
                <input
                  aria-label={`Viewport ${i + 1} width in pixels`}
                  type="number"
                  min={240}
                  max={3840}
                  value={v.width}
                  onChange={(e) => updateViewport(i, { width: Number(e.target.value) })}
                  className={inputClasses}
                />
                <input
                  aria-label={`Viewport ${i + 1} height in pixels`}
                  type="number"
                  min={240}
                  max={4320}
                  value={v.height}
                  onChange={(e) => updateViewport(i, { height: Number(e.target.value) })}
                  className={inputClasses}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewports((vs) => vs.filter((_, j) => j !== i))}
                  disabled={viewports.length === 1}
                  aria-label={`Remove viewport ${v.name || i + 1}`}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          {viewports.length < 6 && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() =>
                setViewports((vs) => [
                  ...vs,
                  { name: `custom-${vs.length + 1}`, width: 1280, height: 800 },
                ])
              }
            >
              <Plus aria-hidden className="size-4" /> Add viewport
            </Button>
          )}
          {Object.entries(fieldErrors)
            .filter(([k]) => k.startsWith("scanDefaults.viewports"))
            .slice(0, 1)
            .map(([k, m]) => (
              <p key={k} className="mt-1 text-xs font-medium text-danger">
                {m}
              </p>
            ))}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Maximum pages" hint="1–500" error={err("scanDefaults.maxPages")}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                name="maxPages"
                type="number"
                min={1}
                max={500}
                defaultValue={project.scanDefaults.maxPages}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={inputClasses}
              />
            )}
          </Field>
          <Field
            label="Maximum link depth"
            hint="0–10 (0 = start page only)"
            error={err("scanDefaults.maxDepth")}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                name="maxDepth"
                type="number"
                min={0}
                max={10}
                defaultValue={project.scanDefaults.maxDepth}
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
            name="respectRobots"
            defaultChecked={project.scanDefaults.respectRobots}
            className="mt-0.5 size-4 accent-[var(--primary)]"
          />
          <span>
            Respect robots.txt
            <span className="block text-xs text-subtle">
              Turn off only for sites you are authorized to test fully.
            </span>
          </span>
        </label>
      </section>

      {status && <Alert tone={status.tone}>{status.text}</Alert>}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
