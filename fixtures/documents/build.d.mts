export function buildZip(
  files: Record<string, string | Buffer>,
  opts?: { deflate?: boolean; declaredSizes?: Record<string, number> },
): Buffer;

export type DocxBlock =
  | { heading: string; level?: number }
  | { li: string }
  | { p?: string; link?: string; href?: string };

export function buildDocx(blocks: DocxBlock[]): Buffer;

export function buildPdf(pages: Array<Array<{ text: string; size: number; gap?: number }>>): Buffer;
