"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * Copies suggested code to the clipboard. Copying only puts text on the clipboard: it never
 * changes the issue's status.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            // No Clipboard API (plain-HTTP deployments) or permission refused: legacy copy.
            setState(legacyCopy(text) ? "copied" : "failed");
          }
        }}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-surface-muted"
      >
        {state === "copied" ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <span role="status" aria-live="polite" className="text-xs text-muted">
        {state === "failed" ? "Copy failed — select the text instead" : ""}
      </span>
    </span>
  );
}
