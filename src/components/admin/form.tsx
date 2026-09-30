"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/input";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Run a server action from a client form: pending state, toast on success/failure, zod field errors, refresh.
 *   const { run, pending, errors } = useAction(updateTeam, { success: "Team saved" });
 */
export function useAction<I, T>(
  fn: (input: I) => Promise<ActionResult<T>>,
  opts: { success?: string | ((data: T) => string); onSuccess?: (data: T) => void; refresh?: boolean } = {},
) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [errors, setErrors] = React.useState<Record<string, string[]>>({});
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  });
  const run = React.useCallback(
    (input: I) =>
      new Promise<ActionResult<T>>((resolve) => {
        startTransition(async () => {
          const res = await fn(input);
          const o = optsRef.current;
          if (res.ok) {
            setErrors({});
            const msg = typeof o.success === "function" ? o.success(res.data) : o.success;
            if (msg) toast.success(msg);
            o.onSuccess?.(res.data);
            if (o.refresh !== false) router.refresh();
          } else {
            setErrors(res.fieldErrors ?? {});
            toast.error(res.error);
          }
          resolve(res);
        });
      }),
    [fn, router],
  );
  return { run, pending, errors, setErrors };
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string[] | string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const msg = Array.isArray(error) ? error[0] : error;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {msg ? (
        <p className="text-xs text-secondary" role="alert">
          <span aria-hidden className="mr-1 text-critical">✕</span>
          {msg}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  id?: string;
}) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-surface-3 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 data-[state=checked]:bg-white"
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-secondary transition-transform duration-150 data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-black" />
    </SwitchPrimitive.Root>
  );
}

/** Button that asks for confirmation in a dialog before running `onConfirm`. */
export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  children,
  ...buttonProps
}: Omit<ButtonProps, "onClick"> & {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <Button type="button" {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="py-2" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Section block used across admin pages. */
export function AdminSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-surface-1", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-base font-medium text-fg">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Dense table shell for admin lists. */
export function AdminTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-x-auto", className)}>
      <table className="w-full min-w-[640px] text-left text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("border-b border-border px-2 py-2 text-xs font-medium text-muted", className)}>{children}</th>;
}
export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-border/60 px-2 py-2 align-middle text-body", className)}>{children}</td>;
}
