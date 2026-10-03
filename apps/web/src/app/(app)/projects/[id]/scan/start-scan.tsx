"use client";

import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

export function StartScan({ projectId, websiteUrl }: { projectId: string; websiteUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const checkboxId = useId();
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const scan = await apiFetch<{ id: string; number: number }>(
        `/api/v1/projects/${projectId}/scans`,
        {
          method: "POST",
          body: { authorizationAttested: true },
        },
      );
      toast.success(`Scan #${scan.number} queued.`);
      router.push(`/projects/${projectId}/scans/${scan.id}`);
    } catch (err) {
      setPending(false);
      setError(err instanceof ApiError ? err.message : "The scan could not be started.");
    }
  }

  return (
    <div className="space-y-3">
      <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
        <input
          id={checkboxId}
          type="checkbox"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        />
        <span>
          I am authorized to test <span className="break-all font-medium">{websiteUrl}</span>. Scans
          only make normal page requests and never attempt intrusive testing.
        </span>
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <Button className="w-full" onClick={start} disabled={!attested || pending}>
        <Play aria-hidden className="size-4" />
        {pending ? "Starting…" : "Start QA Scan"}
      </Button>
    </div>
  );
}
