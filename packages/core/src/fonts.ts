/** Brand font files (browser-safe helpers for the upload forms; the server validates the bytes). */

export const FONT_FORMATS = ["woff2", "woff", "ttf", "otf"] as const;
export type FontFileFormat = (typeof FONT_FORMATS)[number];

/** `accept` attribute for font file inputs. */
export const FONT_ACCEPT = ".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf";

/** Largest font file accepted (MB); fonts are small, so this is below the document limit. */
export const MAX_FONT_FILE_MB = 10;

/** Format implied by a file name, or null when it is not a supported font file name. */
export function fontFormatForFilename(name: string): FontFileFormat | null {
  const m = /\.(woff2|woff|ttf|otf)$/i.exec(name.trim());
  return m ? (m[1]!.toLowerCase() as FontFileFormat) : null;
}
