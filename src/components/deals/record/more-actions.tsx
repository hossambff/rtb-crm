"use client";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Deal header overflow (QA MAJ-10): the secondary actions (share, hand off, request help, upload a call, find
 * executives) live behind one "More" button so the visible row stays at ≤5 actions. The content is force-mounted and
 * only hidden while closed: several items open their own dialogs, which must survive the popover closing when focus
 * moves into them.
 */
export function MoreActions({ children, label = "More actions" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button size="sm" variant="secondary" aria-label={label}>
          <MoreHorizontal /> More
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal forceMount>
        <PopoverPrimitive.Content
          forceMount
          align="end"
          sideOffset={6}
          // Selecting an item that opens a dialog moves focus out → close the menu but keep the item mounted.
          onFocusOutside={() => setOpen(false)}
          className="z-50 flex w-60 flex-col items-stretch gap-1 rounded-md border border-border-strong bg-surface-2 p-1.5 data-[state=closed]:hidden [&_a]:justify-start [&_button]:w-full [&_button]:justify-start"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
