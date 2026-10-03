"use client";

import { AlertTriangle } from "lucide-react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-bg px-6 py-10 text-center"
    >
      <AlertTriangle aria-hidden className="mx-auto mb-3 size-6 text-danger" />
      <h1 className="text-base font-semibold">This page could not be loaded</h1>
      <p className="mt-1 text-sm text-muted">
        An unexpected error occurred. It has been logged on the server.
        {error.digest && (
          <>
            {" "}
            Reference: <code className="font-mono text-xs">{error.digest}</code>
          </>
        )}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
      >
        Try again
      </button>
    </section>
  );
}
