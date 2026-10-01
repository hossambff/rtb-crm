"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import * as Icons from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUP_LABELS, type NavItem } from "@/lib/nav";

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");

/**
 * Left navigation. Items flagged `more` (role-shaped nav, V2 §B2 — chosen in Settings → Preferences) sit under a
 * "More" disclosure; it opens by itself when you're on one of those pages.
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const primary = items.filter((i) => !i.more);
  const more = items.filter((i) => i.more);
  const moreActive = more.some((i) => isActive(pathname, i.href));
  const [moreOpen, setMoreOpen] = useState(false);
  const toggleMore = () => setMoreOpen((o) => !o);
  const showMore = moreOpen || moreActive;
  const groups = (["work", "programs", "insights", "system"] as const).map((g) => ({
    g,
    items: primary.filter((i) => i.group === g),
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
                {items.map((item) => (
                  <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
                ))}
              </ul>
            </div>
          ) : null,
        )}
        {more.length ? (
          <div className="mb-5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation(); // the mobile drawer closes on any click inside it
                toggleMore();
              }}
              aria-expanded={showMore}
              aria-controls="nav-more"
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-secondary transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <Icons.Ellipsis className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
              <span>More</span>
              <span className="ml-auto text-[11px] text-muted tabular">{more.length}</span>
              <Icons.ChevronDown className={cn("size-3.5 text-muted transition-transform duration-150", showMore && "rotate-180")} aria-hidden />
            </button>
            {showMore ? (
              <ul id="nav-more" className="mt-0.5 space-y-0.5">
                {more.map((item) => (
                  <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[item.icon] ?? Icons.Circle;
  return (
    <li>
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
}

export function Logo({ size = 22 }: { size?: number }) {
  // Official Roundtable mark (white, transparent) — public/brand/roundtable-mark-white.png
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/roundtable-mark-white.png" width={size} height={size} alt="" aria-hidden className="shrink-0" />;
}

/** Full ROUNDTABLE lockup (emblem + wordmark), white on transparent. Intrinsic size 826×851. */
export function LogoLockup({ height = 96, className }: { height?: number; className?: string }) {
  const width = Math.round((height * 826) / 851);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/roundtable-lockup-white.png"
      alt="Roundtable"
      width={width}
      height={height}
      style={{ width, height }}
      className={`block shrink-0 self-start object-contain ${className ?? ""}`}
    />
  );
}
