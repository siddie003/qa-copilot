"use client";

import { Info } from "lucide-react";
import { useId } from "react";

/**
 * Small "i" button with a tooltip shown on hover and keyboard focus. The text is also linked
 * with aria-describedby, so screen readers announce it without hovering. It uses display:none
 * (not visibility) while hidden so it never widens the page.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="rounded-full p-0.5 text-subtle hover:text-foreground"
      >
        <Info aria-hidden className="size-3.5" />
      </button>
      <span
        role="tooltip"
        id={id}
        className="absolute bottom-full left-1/2 z-40 mb-2 hidden w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-xs font-normal leading-snug text-background shadow-lg group-focus-within:block group-hover:block"
      >
        {children}
      </span>
    </span>
  );
}
