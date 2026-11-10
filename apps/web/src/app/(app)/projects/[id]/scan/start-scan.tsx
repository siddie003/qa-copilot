"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Start QA Scan. A scan uses the design reference and content documents as they are when it
 * starts, so while references are still unconfirmed or processing (`notReady`), the reasons are
 * shown and the scan starts only after the user explicitly chooses to scan without them.
 * `checking` keeps the button disabled until the caller knows the reference state.
 */
export function StartScan({
  projectId,
  websiteUrl,
  notReady = [],
  checking = false,
}: {
  projectId: string;
  websiteUrl: string;
  notReady?: string[];
  checking?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const checkboxId = useId();
  const anywayId = useId();
  const [attested, setAttested] = useState(false);
  const [anyway, setAnyway] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = notReady.length > 0 && !anyway;

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
      {notReady.length > 0 && (
        <Alert tone="warning">
          <p className="font-medium">References are not ready for this scan</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {notReady.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="mt-1">
            <Link href={`/projects/${projectId}/references`} className="text-primary underline">
              Open References
            </Link>
            , wait until every source is Ready and click Confirm draft, then start the scan.
          </p>
          <label htmlFor={anywayId} className="mt-2 flex items-start gap-2">
            <input
              id={anywayId}
              type="checkbox"
              checked={anyway}
              onChange={(e) => setAnyway(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span>Start anyway: the checks listed above are skipped in this scan.</span>
          </label>
        </Alert>
      )}
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
      <Button
        className="w-full"
        onClick={start}
        disabled={!attested || pending || checking || blocked}
      >
        <Play aria-hidden className="size-4" />
        {pending ? "Starting…" : checking ? "Checking references…" : "Start QA Scan"}
      </Button>
    </div>
  );
}
