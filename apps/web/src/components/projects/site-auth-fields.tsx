"use client";

import { Field, inputClasses } from "@/components/ui/field";

export type SiteAuthDraft =
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; name: string; value: string }
  | { type: "cookies"; cookies: string };

export const EMPTY_AUTH: SiteAuthDraft = { type: "none" };

const TYPES: Array<{ value: SiteAuthDraft["type"]; label: string }> = [
  { value: "none", label: "None (public pages only)" },
  { value: "basic", label: "HTTP Basic authentication" },
  { value: "header", label: "Custom request header (e.g. API key or bearer token)" },
  { value: "cookies", label: "Session cookies" },
];

/** Payload for PUT /scan-auth, or null for "none". */
export function toPayload(d: SiteAuthDraft) {
  return d.type === "none" ? null : d;
}

/**
 * Credentials for scanning login-protected sites. Values are write-only: they are encrypted on
 * the server and never displayed again.
 */
export function SiteAuthFields({
  value,
  onChange,
  errors = {},
}: {
  value: SiteAuthDraft;
  onChange: (v: SiteAuthDraft) => void;
  errors?: Record<string, string>;
}) {
  const setType = (type: SiteAuthDraft["type"]) => {
    if (type === "none") onChange({ type });
    if (type === "basic") onChange({ type, username: "", password: "" });
    if (type === "header") onChange({ type, name: "Authorization", value: "" });
    if (type === "cookies") onChange({ type, cookies: "" });
  };
  return (
    <div className="space-y-4">
      <Field label="Authentication method" error={errors.type}>
        {({ id, describedBy }) => (
          <select
            id={id}
            value={value.type}
            onChange={(e) => setType(e.target.value as SiteAuthDraft["type"])}
            aria-describedby={describedBy}
            className={inputClasses}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {value.type === "basic" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" error={errors.username}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                value={value.username}
                onChange={(e) => onChange({ ...value, username: e.target.value })}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={inputClasses}
              />
            )}
          </Field>
          <Field label="Password" error={errors.password}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="password"
                value={value.password}
                onChange={(e) => onChange({ ...value, password: e.target.value })}
                autoComplete="new-password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={inputClasses}
              />
            )}
          </Field>
        </div>
      )}
      {value.type === "header" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Header name" error={errors.name}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                value={value.name}
                onChange={(e) => onChange({ ...value, name: e.target.value })}
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={inputClasses}
              />
            )}
          </Field>
          <Field label="Header value" hint="For example: Bearer eyJ…" error={errors.value}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="password"
                value={value.value}
                onChange={(e) => onChange({ ...value, value: e.target.value })}
                autoComplete="new-password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className={inputClasses}
              />
            )}
          </Field>
        </div>
      )}
      {value.type === "cookies" && (
        <Field
          label="Cookies"
          hint="Format: name=value; name2=value2 (copy from a logged-in browser session)"
          error={errors.cookies}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="password"
              value={value.cookies}
              onChange={(e) => onChange({ ...value, cookies: e.target.value })}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
      )}
      {value.type !== "none" && (
        <p className="text-xs text-subtle">
          Credentials are encrypted on the server, never shown again, and sent only to this website,
          never to third-party resources such as CDNs or analytics.
        </p>
      )}
    </div>
  );
}
