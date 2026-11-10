export interface GeneratedFigmaNode {
  id: string;
  name: string;
  type: string;
  children?: GeneratedFigmaNode[];
  [key: string]: unknown;
}

export interface GeneratedFigmaFile {
  name: string;
  version: string;
  lastModified: string;
  document: GeneratedFigmaNode & { children: GeneratedFigmaNode[] };
  styles: Record<string, { name: string; styleType: string }>;
}

export function buildFigmaFile(
  pages: number,
  opts?: { hugePage?: number; version?: string },
): GeneratedFigmaFile;

export function pageStyles(
  file: GeneratedFigmaFile,
  pageId: string,
): Record<string, { name: string; styleType: string }>;

export function figmaResponse(file: GeneratedFigmaFile, url: URL): Record<string, unknown> | null;
