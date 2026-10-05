import { AppError } from "@qa/core";
import { getDb, pipelineRepo } from "@qa/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { previousComparable } from "@/server/comparisons";
import { loadProjectForPage } from "@/server/loaders";
import { getScan } from "@/server/scans";
import { LiveScan, type ScanJson } from "./live-scan";

export const metadata: Metadata = { title: "Scan" };

export default async function ScanPage({
  params,
}: {
  params: Promise<{ id: string; scanId: string }>;
}) {
  const { id, scanId } = await params;
  const { user, project } = await loadProjectForPage(id);
  let scan;
  try {
    scan = await getScan(user.id, scanId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (scan.projectId !== project.id) notFound();
  const [captures, previousScan] = await Promise.all([
    pipelineRepo.listCapturesForScan(getDb(), user.id, scanId),
    previousComparable(project.id, scan),
  ]);
  // Same JSON shape as the SSE/REST payloads (dates as ISO strings).
  const initial = JSON.parse(JSON.stringify(scan)) as ScanJson;
  return (
    <LiveScan
      projectId={project.id}
      initial={initial}
      initialCaptures={captures}
      previousScan={previousScan}
    />
  );
}
