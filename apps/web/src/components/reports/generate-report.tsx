"use client";

import { REPORT_FORMATS, REPORT_FORMAT_LABELS, type ReportFormatKey } from "@qa/core/domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field-styles";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/api-client";

const FORMAT_HELP: Record<ReportFormatKey, string> = {
  pdf: "Formatted document to share with developers and stakeholders.",
  md: "Plain text for tickets, pull requests and wikis.",
  json: "Machine-readable, including every finding's full evidence.",
};

export interface ReportableScan {
  id: string;
  number: number;
  statusLabel: string;
  createdAt: string;
}

/** Requests a report of a finished scan (POST /api/v1/scans/:id/reports); the worker builds it. */
export function GenerateReport({
  scans,
  defaultScanId,
}: {
  scans: ReportableScan[];
  defaultScanId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [scanId, setScanId] = useState(defaultScanId);
  const [format, setFormat] = useState<ReportFormatKey>("pdf");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/scans/${scanId}/reports`, { method: "POST", body: { format } });
      const n = scans.find((s) => s.id === scanId)?.number;
      toast.success(`${REPORT_FORMAT_LABELS[format]} report of scan #${n} queued.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The report could not be requested.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Generate a report" className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <div>
          <label htmlFor="report-scan" className="mb-1 block text-xs font-medium text-muted">
            Scan
          </label>
          <select
            id="report-scan"
            value={scanId}
            onChange={(e) => setScanId(e.target.value)}
            className={inputClasses}
          >
            {scans.map((s) => (
              <option key={s.id} value={s.id}>
                Scan #{s.number} · {s.statusLabel} · {s.createdAt}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="min-w-0">
          <legend className="mb-1 text-xs font-medium text-muted">Format</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {REPORT_FORMATS.map((f) => (
              <label
                key={f}
                className="flex cursor-pointer gap-2 rounded-md border border-border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="radio"
                  name="report-format"
                  value={f}
                  checked={format === f}
                  onChange={() => setFormat(f)}
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span>
                  <span className="block font-medium">{REPORT_FORMAT_LABELS[f]}</span>
                  <span className="block text-xs text-muted">{FORMAT_HELP[f]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Requesting…" : "Generate report"}
      </Button>
    </form>
  );
}
