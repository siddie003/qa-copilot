import { ScanSearch } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUserFromHeaders } from "@/server/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Signed-in users have no reason to see the login/sign-up pages.
  if (await getUserFromHeaders(await headers())) redirect("/dashboard");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-lg font-semibold">
        <ScanSearch aria-hidden className="size-6 text-primary" />
        QA Copilot
      </div>
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
        {children}
      </div>
    </main>
  );
}
