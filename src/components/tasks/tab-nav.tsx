import Link from "next/link";
import { cn } from "@/lib/utils";

export type TabDef = { key: string; label: string; count?: number };

/** URL-driven tabs (?tab=…) so each tab is linkable and only the active tab's data is loaded. */
export function TabNav({ tabs, active, basePath }: { tabs: TabDef[]; active: string; basePath: string }) {
  return (
    <nav aria-label="Sections" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <li key={t.key}>
              <Link
                href={`${basePath}?tab=${t.key}`}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150",
                  on ? "border-white text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {t.label}
                {t.count ? (
                  <span className={cn("tabular rounded px-1 text-[11px] leading-4", on ? "bg-white text-black" : "bg-surface-3 text-secondary")}>
                    {t.count > 99 ? "99+" : t.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
