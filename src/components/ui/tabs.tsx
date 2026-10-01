"use client";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { useScrollStrip } from "@/components/ui/scroll-strip";

export const Tabs = TabsPrimitive.Root;
/** Tab strips scroll horizontally on narrow screens (hidden scrollbar + edge fade; active tab scrolled into view). */
export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const ref = useScrollStrip<HTMLDivElement>();
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn("scrollbar-none scroll-fade-x flex gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain shadow-[inset_0_-1px_0_var(--border)]", className)}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "touch-target shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-fg data-[state=active]:border-white data-[state=active]:text-fg",
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("pt-4 focus-visible:outline-none", className)} {...props} />;
}
