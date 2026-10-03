"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, inputClasses } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";

type Errors = Partial<Record<"name" | "email" | "password" | "confirm" | "form", string>>;

export function SignupForm({ minPasswordLength }: { minPasswordLength: number }) {
  const router = useRouter();
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");

    const next: Errors = {};
    if (!name) next.name = "Enter your name.";
    if (!email) next.email = "Enter your email address.";
    if (password.length < minPasswordLength)
      next.password = `Use at least ${minPasswordLength} characters.`;
    if (password !== confirm) next.confirm = "Passwords do not match.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) {
      setPending(false);
      const message =
        error.code === "USER_ALREADY_EXISTS" ||
        error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
          ? "An account with this email already exists."
          : error.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : (error.message ?? "Account could not be created.");
      setErrors({ form: message });
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Create account</h1>
      <p className="mt-1 text-sm text-muted">Start running evidence-based website QA.</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        {errors.form && <Alert tone="error">{errors.form}</Alert>}
        <Field label="Name" error={errors.name}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="name"
              autoComplete="name"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
        <Field label="Email" error={errors.email}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="email"
              type="email"
              autoComplete="email"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
        <Field
          label="Password"
          hint={`At least ${minPasswordLength} characters.`}
          error={errors.password}
        >
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="password"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
        <Field label="Confirm password" error={errors.confirm}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              name="confirm"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={inputClasses}
            />
          )}
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
