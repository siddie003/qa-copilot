"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "./alert";
import { Button } from "./button";
import { inputClasses } from "./field-styles";

/**
 * Modal confirmation built on the native <dialog> (focus trapping, Escape to close).
 * With `confirmText`, the user must type that exact text before confirming.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmText,
  pending,
  error,
  tone = "danger",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmText?: string;
  pending?: boolean;
  error?: string | null;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-dialog-title"
      onClose={() => {
        setTyped("");
        onClose();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-6 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <h2 id="confirm-dialog-title" className="text-lg font-semibold">
        {title}
      </h2>
      <div className="mt-2 text-sm text-muted">{description}</div>
      {confirmText !== undefined && (
        <>
          <label htmlFor="confirm-dialog-input" className="mt-3 block text-sm font-medium">
            Type <span className="font-semibold">{confirmText}</span> to confirm
          </label>
          <input
            id="confirm-dialog-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className={`${inputClasses} mt-1.5`}
          />
        </>
      )}
      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => ref.current?.close()} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant={tone}
          onClick={onConfirm}
          disabled={pending || (confirmText !== undefined && typed !== confirmText)}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
