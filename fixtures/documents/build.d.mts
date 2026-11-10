export function buildZip(
  files: Record<string, string | Buffer>,
  opts?: { deflate?: boolean; declaredSizes?: Record<string, number> },
): Buffer;

export type DocxBlock =
  | { heading: string; level?: number }
  | { li: string }
  | { p?: string; link?: string; href?: string };

export function buildDocx(blocks: DocxBlock[]): Buffer;

export type PdfLine = { text: string; size: number; gap?: number };

/** A page of lines, an image-only page (`{ image: true }`), or a blank page (`[]`). */
export function buildPdf(pages: Array<PdfLine[] | { image: true }>): Buffer;
