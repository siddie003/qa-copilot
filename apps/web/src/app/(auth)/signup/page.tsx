import { getConfig } from "@qa/core";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PASSWORD_MIN_LENGTH } from "@/server/auth";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  await connection();
  if (!getConfig().AUTH_ALLOW_SIGNUP) {
    return (
      <>
        <h1 className="text-xl font-semibold">Sign-up is disabled</h1>
        <p className="mt-2 text-sm text-muted">
          New accounts cannot be created on this installation. Ask an administrator for access.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-sm font-medium text-primary hover:underline"
        >
          Back to sign in
        </Link>
      </>
    );
  }
  return <SignupForm minPasswordLength={PASSWORD_MIN_LENGTH} />;
}
