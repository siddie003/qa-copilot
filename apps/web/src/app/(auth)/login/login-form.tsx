"use client";

import { safeRedirectPath } from "@qa/security/redirect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, inputClasses } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (error) {
      setPending(false);
      setError(
        error.status === 429
          ? "Too many sign-in attempts. Wait a minute and try again."
          : "Email or password is incorrect.",
      );
      return;
    }
    router.replace(safeRedirectPath(next));
    router.refresh();
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted">Access your QA projects and scan results.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Field label="Email">
          {({ id, describedBy }) => (
            <input
              id={id}
              name="email"
              type="email"
              autoComplete="email"
              required
              aria-describedby={describedBy}
              className={inputClasses}
            />
          )}
        </Field>
        <Field label="Password">
          {({ id, describedBy }) => (
            <input
              id={id}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-describedby={describedBy}
              className={inputClasses}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        No account?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create one
        </Link>
      </p>
    </>
  );
}
