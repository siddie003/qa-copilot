import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/cn";

const STYLES = {
  error: { box: "border-danger/30 bg-danger-bg text-danger", Icon: AlertTriangle },
  success: { box: "border-success/30 bg-success-bg text-success", Icon: CheckCircle2 },
  info: { box: "border-info/30 bg-info-bg text-info", Icon: Info },
} as const;

export function Alert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof STYLES;
  children: React.ReactNode;
  className?: string;
}) {
  const { box, Icon } = STYLES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", box, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="text-foreground">{children}</div>
    </div>
  );
}
