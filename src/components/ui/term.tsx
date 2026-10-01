"use client";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { GLOSSARY, type GlossaryId } from "@/lib/glossary";

/**
 * Plain-language definition on hover, focus or tap (V2 §B10): <Term id="muu">MUU</Term>.
 * A popover rather than a tooltip so it also works on touch screens and with the keyboard (Enter/Space, Esc closes).
 */
export function Term({ id, children, className }: { id: GlossaryId; children?: React.ReactNode; className?: string }) {
  const entry = GLOSSARY[id] as { term: string; short: string; long?: string };
  const [open, setOpen] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover = (next: boolean) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (next) setOpen(true);
    else closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  React.useEffect(() => () => void (closeTimer.current && clearTimeout(closeTimer.current)), []);
  if (!entry) return <>{children}</>;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          aria-label={`${typeof children === "string" ? children : entry.term}: what does this mean?`}
          className={cn(
            "inline cursor-help appearance-none border-0 bg-transparent p-0 text-inherit underline decoration-dotted decoration-border-strong underline-offset-[3px] [font:inherit] hover:decoration-secondary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
            className,
          )}
        >
          {children ?? entry.term}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={() => hover(true)}
          onMouseLeave={() => hover(false)}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-72 max-w-[calc(100vw-24px)] rounded-md border border-border-strong bg-surface-2 px-3 py-2.5 text-left normal-case tracking-normal"
        >
          <p className="font-display text-sm text-fg">{entry.term}</p>
          <p className="mt-1 text-xs leading-5 text-body">{entry.short}</p>
          {entry.long ? <p className="mt-1.5 text-xs leading-5 text-muted">{entry.long}</p> : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
