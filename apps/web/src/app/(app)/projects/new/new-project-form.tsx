"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, inputClasses } from "@/components/ui/field";
import { ApiError, apiFetch } from "@/lib/api-client";

export function NewProjectForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const project = await apiFetch<{ id: string }>("/api/v1/projects", {
        method: "POST",
        body: { name: form.get("name"), websiteUrl: form.get("websiteUrl") },
      });
      router.push(`/projects/${project.id}`);
      router.refresh();
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        if (!Object.keys(err.fieldErrors).length) setFormError(err.message);
      } else {
        setFormError("Project could not be created.");
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label="Project name" error={fieldErrors.name}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            name="name"
            required
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
        hint="The page where crawling starts, e.g. https://example.com. https:// is added if omitted."
        error={fieldErrors.websiteUrl}
      >
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            name="websiteUrl"
            required
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
          {pending ? "Creating…" : "Create project"}
        </Button>
        <ButtonLink href="/projects" variant="secondary">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}
