"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Icons from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUP_LABELS, type NavItem } from "@/lib/nav";

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const groups = (["work", "programs", "insights", "system"] as const).map((g) => ({
    g,
    items: items.filter((i) => i.group === g),
  }));
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col self-start border-r border-border bg-surface-1 md:flex">
      <Link href="/home" className="flex h-14 items-center gap-2.5 border-b border-border px-5">
        <Logo />
        <span className="text-[15px] font-semibold uppercase tracking-[0.08em] text-fg">Roundtable</span>
        <span className="ml-auto whitespace-nowrap rounded border border-border-strong px-1 text-[10px] uppercase tracking-wider text-muted">Sales OS</span>
      </Link>
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
        {groups.map(({ g, items }) =>
          items.length ? (
            <div key={g} className="mb-5">
              <p className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted">{NAV_GROUP_LABELS[g]}</p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[item.icon] ?? Icons.Circle;
                  const active = pathname === item.href || pathname.startsWith(item.href + "/");
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                          active ? "bg-surface-2 text-fg" : "text-secondary hover:bg-surface-2/60 hover:text-fg",
                        )}
                      >
                        <Icon className={cn("size-4", active ? "text-fg" : "text-muted")} strokeWidth={1.5} />
                        <span className={active ? "font-medium" : ""}>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
      </nav>
    </aside>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  // Official Roundtable mark (white, transparent) — public/brand/roundtable-mark-white.png
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/roundtable-mark-white.png" width={size} height={size} alt="" aria-hidden className="shrink-0" />;
}

/** Full ROUNDTABLE lockup (emblem + wordmark), white on transparent. */
export function LogoLockup({ height = 96, className }: { height?: number; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/roundtable-lockup-white.png" alt="Roundtable" height={height} style={{ height, width: "auto" }} className={className} />;
}
