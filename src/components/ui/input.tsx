import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-surface-3/40 px-3 text-sm text-body placeholder:text-muted focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-md border border-border bg-surface-3/40 px-3 py-2 text-sm text-body placeholder:text-muted focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-medium text-secondary", className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
