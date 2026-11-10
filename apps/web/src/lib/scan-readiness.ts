/** Why a scan started now would skip a reference comparison (empty when references are ready). */
export function referencesNotReady(state: {
  designConfirmed: boolean;
  designDraft: boolean;
  designProcessing: number;
  documentsProcessing: number;
}): string[] {
  const reasons: string[] = [];
  if (!state.designConfirmed && state.designDraft)
    reasons.push(
      "The design reference is a draft that has not been confirmed: the design comparison would be skipped.",
    );
  else if (!state.designConfirmed && state.designProcessing > 0)
    reasons.push(
      "Figma or brand-guideline values are still being read: the design comparison would be skipped.",
    );
  else if (state.designDraft)
    reasons.push(
      "Newer extracted design values are waiting for review: this scan would use the confirmed version without them.",
    );
  if (state.documentsProcessing > 0)
    reasons.push(
      `${state.documentsProcessing} content document${state.documentsProcessing === 1 ? " is" : "s are"} still processing and would not be compared.`,
    );
  return reasons;
}
