"use client";

import {
  COLOR_ROLE_LABELS,
  COLOR_ROLES,
  COMPONENT_KEYS,
  COMPONENT_LABELS,
  describeSource,
  designSpecSchema,
  TYPOGRAPHY_ROLE_LABELS,
  TYPOGRAPHY_ROLES,
  type ColorRole,
  type ComponentKey,
  type ComponentToken,
  type DesignSpec,
  type TokenSource,
  type TypographyRole,
  type TypographyToken,
} from "@qa/core/design-spec";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field-styles";
import { cn } from "@/lib/cn";

const MANUAL: TokenSource = { type: "manual" };
const cell = cn(inputClasses, "h-8 min-w-0 px-2 text-sm");

interface ColorRow {
  id: number;
  name: string;
  value: string;
  role: ColorRole | "";
  source: TokenSource;
}

let rowId = 0;
const toRows = (spec: DesignSpec): ColorRow[] =>
  Object.entries(spec.colors).map(([name, c]) => ({
    id: ++rowId,
    name,
    value: c.value,
    role: c.role ?? "",
    source: c.source,
  }));

const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));
const str = (v: number | undefined) => (v === undefined ? "" : String(v));

/** Removes undefined/empty keys; a token with no values left is dropped. */
function compact<T extends Record<string, unknown>>(t: T): T | undefined {
  const out = Object.fromEntries(
    Object.entries(t).filter(([, v]) => v !== undefined && v !== ""),
  ) as T;
  return Object.keys(out).some((k) => !["source", "scope"].includes(k)) ? out : undefined;
}

function SourceNote({ source }: { source: TokenSource | undefined }) {
  if (!source || source.type === "manual") return null;
  return (
    <span className="block truncate text-xs text-subtle" title={describeSource(source)}>
      From {describeSource(source)}
    </span>
  );
}

/**
 * Editor for design tokens (colors, typography, buttons, container, spacing scale) with JSON
 * import/export. Values edited by hand are marked as manually entered; untouched values keep
 * their Figma or document citation.
 */
export function DesignSpecEditor({
  initial,
  onSubmit,
  submitLabel,
  disabled,
  disabledReason,
  pending,
}: {
  initial: DesignSpec;
  onSubmit: (spec: DesignSpec) => void | Promise<void>;
  submitLabel: string;
  disabled?: boolean;
  disabledReason?: string;
  pending?: boolean;
}) {
  const [colors, setColors] = useState<ColorRow[]>(() => toRows(initial));
  const [typography, setTypography] = useState(initial.typography);
  const [components, setComponents] = useState(initial.components);
  const [container, setContainer] = useState(initial.layout.containerMaxWidth);
  const [scale, setScale] = useState(initial.spacing.scale?.values.join(", ") ?? "");
  const [scaleSource, setScaleSource] = useState(initial.spacing.scale?.source);
  const [errors, setErrors] = useState<string[]>([]);
  const [json, setJson] = useState("");

  const load = (spec: DesignSpec) => {
    setColors(toRows(spec));
    setTypography(spec.typography);
    setComponents(spec.components);
    setContainer(spec.layout.containerMaxWidth);
    setScale(spec.spacing.scale?.values.join(", ") ?? "");
    setScaleSource(spec.spacing.scale?.source);
  };

  function build(): { spec?: DesignSpec; problems: string[] } {
    const problems: string[] = [];
    const names = new Set<string>();
    const colorRecord: Record<string, unknown> = {};
    for (const c of colors) {
      if (!c.name.trim() && !c.value.trim()) continue;
      const name = c.name.trim();
      if (names.has(name)) problems.push(`The color name “${name}” is used twice.`);
      names.add(name);
      colorRecord[name] = {
        value: c.value.trim(),
        ...(c.role ? { role: c.role } : {}),
        source: c.source,
      };
    }
    const roles = colors.map((c) => c.role).filter(Boolean);
    if (new Set(roles).size !== roles.length)
      problems.push("Each color role can be assigned to one color only.");
    const scaleValues = scale
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
    if (scaleValues.some((v) => !Number.isFinite(v)))
      problems.push("The spacing scale must be numbers separated by commas.");
    const raw = {
      colors: colorRecord,
      typography: Object.fromEntries(
        Object.entries(typography)
          .map(([k, t]) => [k, t && compact(t)])
          .filter(([, t]) => t),
      ),
      components: Object.fromEntries(
        Object.entries(components)
          .map(([k, t]) => [k, t && compact(t)])
          .filter(([, t]) => t),
      ),
      layout:
        container?.value !== undefined && Number.isFinite(container.value)
          ? { containerMaxWidth: compact(container) }
          : {},
      spacing: scaleValues.length
        ? { scale: { values: scaleValues, source: scaleSource ?? MANUAL } }
        : {},
    };
    const parsed = designSpecSchema.safeParse(raw);
    if (!parsed.success)
      problems.push(
        ...parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(" › ") || "Value"}: ${i.message}`),
      );
    return problems.length ? { problems } : { spec: parsed.data!, problems };
  }

  async function submit() {
    const { spec, problems } = build();
    setErrors(problems);
    if (spec) await onSubmit(spec);
  }

  const setTypo = (role: TypographyRole, patch: Partial<TypographyToken>) =>
    setTypography((t) => ({ ...t, [role]: { ...(t[role] ?? {}), ...patch, source: MANUAL } }));
  const setComp = (key: ComponentKey, patch: Partial<ComponentToken>) =>
    setComponents((c) => ({ ...c, [key]: { ...(c[key] ?? {}), ...patch, source: MANUAL } }));
  const setColor = (id: number, patch: Partial<ColorRow>) =>
    setColors((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch, source: MANUAL } : r)));

  return (
    <div className="space-y-6">
      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold">Colors</legend>
        <p className="text-xs text-subtle">
          Brand palette. Assign a role to compare a color with a specific part of the website.
        </p>
        {colors.length > 0 && (
          <div role="region" aria-label="Colors" tabIndex={0} className="relative overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Value
                  </th>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    Website role
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {colors.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="py-1 pr-2">
                      <input
                        aria-label="Color name"
                        value={c.name}
                        onChange={(e) => setColor(c.id, { name: e.target.value })}
                        className={cell}
                      />
                      <SourceNote source={c.source} />
                    </td>
                    <td className="py-1 pr-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label={`Pick color for ${c.name || "this color"}`}
                          value={/^#[0-9a-f]{6}/i.test(c.value) ? c.value.slice(0, 7) : "#000000"}
                          onChange={(e) => setColor(c.id, { value: e.target.value })}
                          className="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-surface"
                        />
                        <input
                          aria-label={`Hex value for ${c.name || "this color"}`}
                          value={c.value}
                          onChange={(e) => setColor(c.id, { value: e.target.value })}
                          placeholder="#1A56DB"
                          className={cn(cell, "w-28 font-mono")}
                        />
                      </div>
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        aria-label={`Website role for ${c.name || "this color"}`}
                        value={c.role}
                        onChange={(e) => setColor(c.id, { role: e.target.value as ColorRole | "" })}
                        className={cell}
                      >
                        <option value="">Palette only</option>
                        {COLOR_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {COLOR_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove color ${c.name}`}
                        onClick={() => setColors((rows) => rows.filter((r) => r.id !== c.id))}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setColors((rows) => [
              ...rows,
              { id: ++rowId, name: "", value: "", role: "", source: MANUAL },
            ])
          }
        >
          <Plus aria-hidden className="size-4" /> Add color
        </Button>
      </fieldset>

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold">Typography</legend>
        <p className="text-xs text-subtle">
          Leave a field empty if the design does not define it. Sizes in px; sizes are compared at
          the widest viewport. A CSS selector (optional) maps the role to specific elements.
        </p>
        <div
          role="region"
          aria-label="Typography"
          tabIndex={0}
          className="relative overflow-x-auto"
        >
          <table className="w-full min-w-[920px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                {[
                  "Role",
                  "Font family",
                  "Size",
                  "Weight",
                  "Line height",
                  "Letter spacing",
                  "Color",
                  "Selector",
                ].map((h) => (
                  <th key={h} scope="col" className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TYPOGRAPHY_ROLES.map((role) => {
                const t = typography[role];
                const label = TYPOGRAPHY_ROLE_LABELS[role];
                return (
                  <tr key={role} className="align-top">
                    <th scope="row" className="py-1 pr-2 text-left font-medium">
                      {label}
                      <SourceNote source={t?.source} />
                    </th>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} font family`}
                        value={t?.fontFamily ?? ""}
                        onChange={(e) => setTypo(role, { fontFamily: e.target.value || undefined })}
                        placeholder="Inter"
                        className={cn(cell, "w-36")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} font size in px`}
                        type="number"
                        step="any"
                        min={1}
                        value={str(t?.fontSize)}
                        onChange={(e) => setTypo(role, { fontSize: num(e.target.value) })}
                        className={cn(cell, "w-20")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} font weight`}
                        type="number"
                        step={100}
                        min={100}
                        max={1000}
                        value={str(t?.fontWeight)}
                        onChange={(e) => setTypo(role, { fontWeight: num(e.target.value) })}
                        className={cn(cell, "w-20")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} line height in px`}
                        type="number"
                        step="any"
                        min={0}
                        value={str(t?.lineHeight)}
                        onChange={(e) => setTypo(role, { lineHeight: num(e.target.value) })}
                        className={cn(cell, "w-20")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} letter spacing in px`}
                        type="number"
                        step="any"
                        value={str(t?.letterSpacing)}
                        onChange={(e) => setTypo(role, { letterSpacing: num(e.target.value) })}
                        className={cn(cell, "w-20")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} color`}
                        value={t?.color ?? ""}
                        onChange={(e) => setTypo(role, { color: e.target.value || undefined })}
                        placeholder="#222222"
                        className={cn(cell, "w-24 font-mono")}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`${label} CSS selector`}
                        value={t?.selector ?? ""}
                        onChange={(e) => setTypo(role, { selector: e.target.value || undefined })}
                        placeholder="optional"
                        className={cn(cell, "w-32 font-mono")}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </fieldset>

      <fieldset className="min-w-0 space-y-2">
        <legend className="text-sm font-semibold">Buttons</legend>
        <div className="grid gap-4 md:grid-cols-2">
          {COMPONENT_KEYS.map((key) => {
            const t = components[key];
            const label = COMPONENT_LABELS[key];
            const field = (
              name: keyof ComponentToken,
              text: string,
              kind: "color" | "number" | "text",
              placeholder?: string,
            ) => (
              <label className="grid gap-1 text-xs font-medium text-muted">
                {text}
                <input
                  type={kind === "number" ? "number" : "text"}
                  step="any"
                  value={
                    kind === "number"
                      ? str(t?.[name] as number | undefined)
                      : ((t?.[name] as string | undefined) ?? "")
                  }
                  onChange={(e) =>
                    setComp(key, {
                      [name]: kind === "number" ? num(e.target.value) : e.target.value || undefined,
                    })
                  }
                  placeholder={placeholder}
                  className={cn(cell, kind !== "number" && "font-mono")}
                />
              </label>
            );
            return (
              <div key={key} className="rounded-md border border-border p-3">
                <p className="mb-2 text-sm font-medium">{label}</p>
                <SourceNote source={t?.source} />
                <div className="grid grid-cols-2 gap-2">
                  {field("background", "Background", "color", "#1A56DB")}
                  {field("color", "Text color", "color", "#FFFFFF")}
                  {field("borderRadius", "Corner radius (px)", "number")}
                  {field("fontSize", "Font size (px)", "number")}
                  {field("paddingX", "Padding left/right (px)", "number")}
                  {field("paddingY", "Padding top/bottom (px)", "number")}
                  {field("fontWeight", "Font weight", "number")}
                  {field("selector", "CSS selector (optional)", "text", ".btn-primary")}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="grid min-w-0 gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Layout and spacing</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs font-medium text-muted">
            Container max width (px)
            <input
              type="number"
              step="any"
              value={str(container?.value)}
              onChange={(e) =>
                setContainer((c) => ({
                  ...(c ?? {}),
                  value: num(e.target.value) as number,
                  source: MANUAL,
                }))
              }
              className={cell}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted">
            Container selector
            <input
              value={container?.selector ?? ""}
              onChange={(e) =>
                setContainer((c) => ({
                  ...(c ?? { value: undefined as unknown as number }),
                  selector: e.target.value || undefined,
                  source: MANUAL,
                }))
              }
              placeholder=".container"
              className={cn(cell, "font-mono")}
            />
          </label>
          <SourceNote source={container?.source} />
        </div>
        <label className="grid gap-1 text-xs font-medium text-muted">
          Spacing scale (px, comma separated)
          <input
            value={scale}
            onChange={(e) => {
              setScale(e.target.value);
              setScaleSource(MANUAL);
            }}
            placeholder="4, 8, 16, 24, 32"
            className={cell}
          />
        </label>
      </fieldset>

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Import or export JSON</summary>
        <div className="mt-3 space-y-2">
          <label className="grid gap-1 text-xs font-medium text-muted">
            Design reference JSON
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder='{"colors": {"Primary": {"value": "#1A56DB"}}}'
              className={cn(inputClasses, "h-auto py-2 font-mono text-xs")}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const { spec, problems } = build();
                setErrors(problems);
                if (spec) setJson(JSON.stringify(spec, null, 2));
              }}
            >
              Export current values
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                try {
                  const parsed = designSpecSchema.safeParse(JSON.parse(json));
                  if (!parsed.success)
                    return setErrors(
                      parsed.error.issues
                        .slice(0, 8)
                        .map((i) => `${i.path.join(" › ")}: ${i.message}`),
                    );
                  setErrors([]);
                  load(parsed.data);
                } catch {
                  setErrors(["The text is not valid JSON."]);
                }
              }}
            >
              Load JSON into the editor
            </Button>
          </div>
        </div>
      </details>

      {errors.length > 0 && (
        <Alert tone="error">
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={disabled || pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        {disabled && disabledReason && <span className="text-sm text-muted">{disabledReason}</span>}
      </div>
    </div>
  );
}
