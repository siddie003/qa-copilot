import {
  CHANGE_CATEGORY_LABELS,
  FINDING_CHANGE_LABELS,
  type ChangeCategory,
  type FindingChangeCategory,
} from "@qa/core/comparison";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";

/** Tone per comparison category; the label is always shown, so color is never the only signal. */
export const CHANGE_TONES: Record<ChangeCategory, PillTone> = {
  new: "danger",
  reopened: "danger",
  changed: "warning",
  resolved: "success",
  persistent: "neutral",
  not_rechecked: "neutral",
  newly_checked: "info",
};

const FINDING_TONES: Record<FindingChangeCategory, PillTone> = {
  new: "danger",
  fixed: "success",
  changed: "warning",
  persistent: "neutral",
  not_rechecked: "neutral",
  newly_checked: "info",
};

export function ChangeBadge({ category }: { category: ChangeCategory }) {
  return <StatusPill tone={CHANGE_TONES[category]}>{CHANGE_CATEGORY_LABELS[category]}</StatusPill>;
}

export function FindingChangeBadge({ category }: { category: FindingChangeCategory }) {
  return <StatusPill tone={FINDING_TONES[category]}>{FINDING_CHANGE_LABELS[category]}</StatusPill>;
}
