import "server-only";
import {
  AppError,
  getConfig,
  scanAuthSchema,
  summarizeScanAuth,
  type ScanAuth,
  type ScanAuthSummary,
} from "@qa/core";
import { getDb, secretsRepo } from "@qa/db";
import { encryptSecret } from "@qa/security";
import { getProject } from "./projects";

export { scanAuthSchema };

/** Non-secret summary of the project's site credentials, or null when none are configured. */
export async function getScanAuthSummary(
  userId: string,
  projectId: string,
): Promise<ScanAuthSummary | null> {
  const project = await getProject(userId, projectId);
  const row = await secretsRepo.getProjectSecret(getDb(), project.id, secretsRepo.SCAN_AUTH_KIND);
  return (row?.summary as ScanAuthSummary | undefined) ?? null;
}

/** Encrypts and stores credentials (AES-256-GCM, bound to the project id). */
export async function setScanAuth(userId: string, projectId: string, auth: ScanAuth) {
  const project = await getProject(userId, projectId);
  const key = getConfig().ENCRYPTION_KEY;
  if (!key)
    throw new AppError(
      "CONFIG_ERROR",
      "Site credentials cannot be stored because ENCRYPTION_KEY is not configured on the server",
      { expose: true },
    );
  const summary = summarizeScanAuth(auth);
  await secretsRepo.setProjectSecret(
    getDb(),
    project.id,
    secretsRepo.SCAN_AUTH_KIND,
    encryptSecret(JSON.stringify(auth), key, project.id),
    summary as unknown as Record<string, unknown>,
  );
  return summary;
}

export async function clearScanAuth(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  return secretsRepo.deleteProjectSecret(getDb(), project.id, secretsRepo.SCAN_AUTH_KIND);
}
