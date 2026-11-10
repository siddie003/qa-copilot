"use client";

import { useEffect, useRef, useState } from "react";
import { FindingGuide, type ExplainedFinding } from "./plain-explanation";

/**
 * The finding's fix guide, built in the browser when its row is opened. A scan can list hundreds
 * of findings per page; rendering every guide on the server would multiply the page size. The
 * finding linked in the URL (`initiallyOpen`) is rendered on the server.
 */
export function LazyFindingGuide({
  initiallyOpen,
  ...props
}: {
  finding: ExplainedFinding;
  issueHref?: string;
  issueLabel?: string;
  initiallyOpen: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(initiallyOpen);
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details || shown) return;
    const onToggle = () => {
      if (details.open) setShown(true);
    };
    if (details.open) setShown(true);
    details.addEventListener("toggle", onToggle);
    return () => details.removeEventListener("toggle", onToggle);
  }, [shown]);
  return <div ref={ref}>{shown ? <FindingGuide {...props} /> : null}</div>;
}
