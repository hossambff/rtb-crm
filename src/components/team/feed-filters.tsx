import Link from "next/link";
import { cn } from "@/lib/utils";
import { ScrollStrip } from "@/components/ui/scroll-strip";

export type FilterChip = { key: string; label: string; href: string; count?: number };

/** URL-driven filter chips (kind / tag). */
export function FilterChips({ chips, active, label }: { chips: FilterChip[]; active: string; label: string }) {
  return (
    <ScrollStrip as="nav" aria-label={label} activeKey={active} className="-mx-4 px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1.5">
        {chips.map((c) => {
          const on = c.key === active;
          return (
            <li key={c.key}>
              <Link
                href={c.href}
                scroll={false}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150",
                  on ? "border-white bg-white text-black" : "border-border text-secondary hover:border-border-strong hover:text-fg",
                )}
              >
                {c.label}
                {c.count != null ? <span className={cn("tabular text-xs", on ? "text-black/60" : "text-muted")}>{c.count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </ScrollStrip>
  );
}
