import type { HistoryScan } from "@qa/db";
import { buttonClasses } from "@/components/ui/button";
import { inputClasses } from "@/components/ui/field-styles";
import { formatDate, scanStatusLabel } from "@/lib/format";

const FINISHED = new Set(["completed", "completed_with_failures", "failed", "cancelled"]);

function option(s: HistoryScan) {
  const issues = s.groundingStatus === "completed" ? `${s.issueCount} issues` : "no issue records";
  return `Scan #${s.number} · ${formatDate(s.startedAt ?? s.createdAt)} · ${scanStatusLabel(s.status)} · ${issues}`;
}

/** Picks two finished scans to compare (plain GET form: works without JavaScript). */
export function CompareForm({
  projectId,
  scans,
  baseId,
  targetId,
}: {
  projectId: string;
  scans: HistoryScan[];
  baseId?: string;
  targetId?: string;
}) {
  const finished = scans.filter((s) => FINISHED.has(s.status));
  return (
    <form
      method="get"
      action={`/projects/${projectId}/history/compare`}
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
    >
      <label className="block min-w-0 text-sm">
        <span className="mb-1 block font-medium">Base scan (earlier)</span>
        <select name="base" defaultValue={baseId} className={inputClasses}>
          {finished.map((s) => (
            <option key={s.id} value={s.id}>
              {option(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="block min-w-0 text-sm">
        <span className="mb-1 block font-medium">Target scan (later)</span>
        <select name="target" defaultValue={targetId} className={inputClasses}>
          {finished.map((s) => (
            <option key={s.id} value={s.id}>
              {option(s)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className={buttonClasses("primary")}>
        Compare
      </button>
    </form>
  );
}
