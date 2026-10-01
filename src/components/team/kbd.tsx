import { cn } from "@/lib/utils";

/** Keyboard hint chip (visible shortcuts, V2 §0.5). */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex min-w-4 items-center justify-center rounded border border-border-strong px-1 font-sans text-[10px] leading-4 text-secondary", className)}>{children}</kbd>;
}
