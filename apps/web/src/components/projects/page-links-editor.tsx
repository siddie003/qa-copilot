"use client";

import { MAX_PAGE_LINKS } from "@qa/core/domain";
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field";
import { cn } from "@/lib/cn";

export interface PageLinkItem {
  id: string;
  url: string;
  path: string;
}

interface Props {
  websiteUrl: string;
  links: PageLinkItem[];
  /** Adds a link; resolves to an error message, or null when it was added. */
  onAdd(url: string): Promise<string | null> | string | null;
  onRemove(link: PageLinkItem): Promise<void> | void;
  /** Ids of links whose removal is in progress. */
  removing?: string[];
}

/**
 * "Page links": specific pages of the website that every scan includes, in addition to the pages
 * the crawler finds by following links. A URL input with a visible "+ Add page" button and the
 * list of added pages, each removable.
 */
export function PageLinksEditor({ websiteUrl, links, onAdd, onRemove, removing = [] }: Props) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const host = (() => {
    try {
      return new URL(websiteUrl).host;
    } catch {
      return "your website";
    }
  })();
  const full = links.length >= MAX_PAGE_LINKS;

  async function add() {
    if (!value.trim()) {
      setError("Enter a page URL, for example /about or the full address.");
      return;
    }
    setAdding(true);
    try {
      const problem = await onAdd(value.trim());
      setError(problem);
      if (!problem) setValue("");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={inputId} className="text-sm font-medium">
          Page URL
        </label>
        <p id={hintId} className="text-xs text-muted">
          A page of {host} that every scan must include, for example {websiteUrl.replace(/\/$/, "")}
          /about or just /about. Optional: without page links the scan starts at the website URL and
          follows its links. Up to {MAX_PAGE_LINKS} pages.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            id={inputId}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            inputMode="url"
            placeholder={`${websiteUrl.replace(/\/$/, "")}/about`}
            aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
            aria-invalid={Boolean(error)}
            disabled={full}
            className={cn(inputClasses, "min-w-0 flex-1 font-mono")}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => void add()}
            disabled={adding || full}
          >
            <Plus aria-hidden className="size-4" />
            {adding ? "Adding…" : "Add page"}
          </Button>
        </div>
        {error && (
          <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-danger">
            {error}
          </p>
        )}
        {full && (
          <p className="mt-1 text-xs text-muted">
            The maximum of {MAX_PAGE_LINKS} pages is reached; remove one to add another.
          </p>
        )}
      </div>
      <div>
        <p className="text-sm font-medium" id={`${inputId}-list`}>
          Added pages ({links.length})
        </p>
        {links.length === 0 ? (
          <p className="text-sm text-muted">No pages added.</p>
        ) : (
          <ul
            aria-labelledby={`${inputId}-list`}
            className="mt-1 divide-y divide-border rounded-md border border-border"
          >
            {links.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono" title={l.url}>
                    {l.path}
                  </span>
                  <span className="block truncate text-xs text-subtle">{l.url}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${l.path}`}
                  disabled={removing.includes(l.id)}
                  onClick={() => void onRemove(l)}
                >
                  <Trash2 aria-hidden className="size-4" />
                  <span className="hidden sm:inline">
                    {removing.includes(l.id) ? "Removing…" : "Remove"}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
