"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

// Further project sections (Scan, Issues, Pages, Scanner Results, Reports, Scan History)
// are added as their phases are implemented, so no tab leads to a placeholder.
const TABS = [
  { segment: "", label: "Overview" },
  { segment: "/settings", label: "Settings" },
];

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  return (
    <nav aria-label="Project sections" className="border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const href = base + t.segment;
          const active = pathname === href;
          return (
            <li key={t.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-muted hover:border-border-strong hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
