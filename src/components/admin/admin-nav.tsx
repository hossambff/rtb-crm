"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ScrollStrip } from "@/components/ui/scroll-strip";

export type AdminNavItem = { href: string; label: string };

export function AdminNav({ items }: { items: AdminNavItem[] }) {
  const pathname = usePathname();
  return (
    <ScrollStrip
      as="nav"
      activeKey={pathname}
      aria-label="Admin sections"
      className="-mx-1 flex gap-1 border-b border-border pb-px xl:mx-0 xl:flex-col xl:overflow-visible xl:border-b-0 xl:pb-0 xl:[mask-image:none]"
    >
      {items.map((it) => {
        const active = it.href === "/admin" ? pathname === "/admin" : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "touch-target flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
              active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </ScrollStrip>
  );
}

export function NoAccess({ message = "You don't have permission to view this page." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
      <p className="font-display text-lg text-fg">No access</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
    </div>
  );
}
