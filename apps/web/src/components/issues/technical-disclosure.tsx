"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * Collapsible "Technical details and evidence" section. Closed by default; it opens itself when
 * the page is opened (or a link is followed) with a #fragment that points inside it, such as
 * #evidence, so in-page links and shared links keep working.
 */
export function TechnicalDisclosure({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!target || !ref.current?.contains(target)) return;
      ref.current.open = true;
      target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  return (
    <details
      ref={ref}
      id="technical"
      className="group rounded-lg border border-border bg-surface open:bg-transparent open:border-transparent"
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-lg px-4 py-3 hover:bg-surface-muted group-open:mb-4 group-open:border group-open:border-border group-open:bg-surface [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted transition-transform group-open:rotate-90"
        />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-muted">{hint}</span>
        </span>
      </summary>
      <div className="space-y-6">{children}</div>
    </details>
  );
}
