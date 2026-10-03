"use client";

import { Menu, ScanSearch, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { MAIN_NAV, isActive } from "./nav-items";
import { UserMenu } from "./user-menu";

function Brand() {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2 rounded-md px-1 text-base font-semibold text-white"
    >
      <ScanSearch aria-hidden className="size-5 text-blue-400" />
      QA Copilot
    </Link>
  );
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="space-y-1">
      {MAIN_NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-active text-sidebar-active-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-white",
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({
  user,
  children,
}: {
  user: { name: string; email: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-foreground focus:shadow"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:gap-6 lg:px-3 lg:py-5">
        <Brand />
        <nav aria-label="Main" className="flex-1">
          <NavList pathname={pathname} />
        </nav>
        <UserMenu user={user} />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="flex items-center justify-between bg-sidebar px-4 py-3 lg:hidden">
        <Brand />
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          className="rounded-md p-2 text-sidebar-foreground hover:bg-sidebar-active"
        >
          {mobileOpen ? (
            <X aria-hidden className="size-5" />
          ) : (
            <Menu aria-hidden className="size-5" />
          )}
          <span className="sr-only">{mobileOpen ? "Close navigation" : "Open navigation"}</span>
        </button>
      </header>
      {mobileOpen && (
        <nav id="mobile-nav" aria-label="Main" className="bg-sidebar px-3 pb-4 lg:hidden">
          <NavList pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          <div className="mt-4">
            <UserMenu user={user} />
          </div>
        </nav>
      )}

      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </div>
  );
}
