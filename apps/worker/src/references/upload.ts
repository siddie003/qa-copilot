import type { ContentDocumentKind } from "@qa/core";
import { ExtractionError } from "@qa/reference";
import { validateDocumentUpload, verifyDocumentContent } from "@qa/security";
import type { ReferenceRuntime } from "./process";

/**
 * Reads a stored upload and re-validates it (the worker never trusts the web tier's check):
 * name, size, declared type, magic bytes, encoding, and every DOCX entry's real size before any
 * parser decompresses anything (zip bombs).
 */
export async function readUpload(
  rt: ReferenceRuntime,
  storageKey: string,
  filename: string,
): Promise<{ kind: ContentDocumentKind; bytes: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await rt.storage.read(storageKey);
  } catch {
    throw new ExtractionError("The uploaded file is missing from storage. Upload it again.");
  }
  const check = validateDocumentUpload({
    filename,
    bytes,
    limits: { maxBytes: rt.config.MAX_UPLOAD_MB * 1024 * 1024 },
  });
  if (!check.ok) throw new ExtractionError(check.message);
  const content = await verifyDocumentContent({ kind: check.kind, bytes });
  if (content) throw new ExtractionError(content.message);
  return { kind: check.kind, bytes };
}
