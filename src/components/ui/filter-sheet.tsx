"use client";
import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Secondary filters that sit inline on md+ and collapse behind a "Filters (n)" button + bottom sheet on phones.
 * Children are rendered inline (display: contents, so they join the parent flex row) from md up; on phones they
 * render inside the sheet, stacked full width. Keep search and the primary toggle OUTSIDE this component so
 * they stay visible on every width.
 */
export function FilterSheet({
  count = 0,
  onClear,
  title = "Filters",
  children,
  className,
  triggerClassName,
}: {
  /** Number of active secondary filters (shown on the trigger). */
  count?: number;
  /** Clears the secondary filters; the button only shows when count > 0. */
  onClear?: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <div className={cn("hidden md:contents", className)}>{children}</div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="secondary" size="sm" className={cn("md:hidden", triggerClassName)} aria-label={count ? `${title}, ${count} active` : title}>
            <SlidersHorizontal />
            {title}
            {count ? <span className="tabular rounded bg-white px-1 text-[11px] leading-4 text-black">{count}</span> : null}
          </Button>
        </DialogTrigger>
        <DialogContent side="bottom" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col items-stretch gap-3 space-y-0 [&_select]:w-full [&_select]:max-w-none [&>*]:w-full [&_[role=radiogroup]>*]:flex-1">{children}</DialogBody>
          <DialogFooter className="justify-between">
            {onClear && count ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                Clear
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
