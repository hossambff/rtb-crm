"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * side="center" (default): centered modal on sm+, a full-width bottom sheet on phones (max 90dvh, internal scroll,
 * safe-area padding). side="bottom": bottom sheet at every width (filter sheets). side="right": full-height drawer.
 */
export function DialogContent({
  className,
  children,
  side,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { side?: "center" | "right" | "bottom" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[1px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 overscroll-contain border border-border-strong bg-surface-2 shadow-none focus:outline-none",
          side === "right"
            ? "inset-y-0 right-0 h-full max-h-dvh w-full max-w-xl overflow-y-auto border-y-0 border-r-0 pb-[env(safe-area-inset-bottom)]"
            : side === "bottom"
              ? "inset-x-0 bottom-0 max-h-[90dvh] w-full overflow-y-auto rounded-t-xl border-b-0 animate-[sheet-in_180ms_ease-out] sm:left-1/2 sm:max-w-lg sm:-translate-x-1/2"
              : cn(
                  // Phones: bottom sheet.
                  "inset-x-0 bottom-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-xl border-b-0 animate-[sheet-in_180ms_ease-out]",
                  // sm+: centered modal.
                  "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-none sm:rounded-lg sm:border-b",
                ),
          className,
          // Never wider than the viewport on phones, whatever max-w the caller asked for.
          side !== "right" && "max-sm:max-w-none",
        )}
        {...props}
      >
        {side !== "right" ? <span aria-hidden className="mx-auto mt-2 block h-1 w-10 rounded-full bg-border-strong sm:hidden" /> : null}
        {children}
        <DialogPrimitive.Close
          className="touch-target absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded text-muted hover:text-fg sm:right-3 sm:top-3 sm:size-6"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-border px-5 py-4 pr-10", className)} {...props} />;
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("font-display text-lg font-medium text-fg", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("mt-1 text-xs text-muted", className)} {...props} />;
}
export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-4 px-5 py-4 max-sm:last:pb-[max(1rem,env(safe-area-inset-bottom))]", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    // Sticky so primary actions stay reachable while a long dialog body scrolls (bottom sheet on phones).
  return (
    <div
      className={cn(
        "sticky bottom-0 z-[1] flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    />
  );
}
