"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export function UserMenu({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    setPending(true);
    setError(false);
    const { error } = await authClient.signOut();
    if (error) {
      setPending(false);
      setError(true);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="border-t border-white/10 pt-4">
      <p className="truncate px-1 text-sm font-medium text-white" title={user.name}>
        {user.name}
      </p>
      <p className="truncate px-1 text-xs text-sidebar-foreground" title={user.email}>
        {user.email}
      </p>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="mt-3 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-active hover:text-white disabled:opacity-60"
      >
        <LogOut aria-hidden className="size-4" />
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <p role="alert" className="mt-1 px-1 text-xs text-red-300">
          Sign-out failed. Try again.
        </p>
      )}
    </div>
  );
}
