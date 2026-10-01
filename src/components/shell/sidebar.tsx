"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import * as Icons from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUP_LABELS, NAV_GROUPS, type NavGroup, type NavItem } from "@/lib/nav";

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");

const COLLAPSE_KEY = "rso.nav.collapsed";
/** Groups collapsed until the user opens them (the System footer is admin plumbing, not daily work). */
const DEFAULT_COLLAPSED: NavGroup[] = ["system"];

const DEFAULT_RAW = JSON.stringify(DEFAULT_COLLAPSED);
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function snapshot(): string {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) ?? DEFAULT_RAW;
  } catch {
    return DEFAULT_RAW;
  }
}
function parseCollapsed(raw: string): NavGroup[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v.filter((g) => (NAV_GROUPS as readonly string[]).includes(g)) as NavGroup[]) : DEFAULT_COLLAPSED;
  } catch {
    return DEFAULT_COLLAPSED;
  }
}
function writeCollapsed(next: NavGroup[]) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

/**
 * Left navigation, grouped by intent (My Day + Copilot + Tasks on top, then Sell, Engage, Programs, Insights, System).
 * Every permitted item is visible — no "More" menu; groups collapse (remembered per browser) and the group holding the
 * current page always stays open.
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  // remembered per browser; the server render uses the default, so hydration matches
  const raw = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_RAW);
  const collapsed = useMemo(() => parseCollapsed(raw), [raw]);
  const toggle = (g: NavGroup) => writeCollapsed(collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g]);
  const groups = NAV_GROUPS.map((g) => ({ g, items: items.filter((i) => i.group === g) })).filter((x) => x.items.length);
  // only the most specific match is "current" (e.g. /team/setup highlights Team setup, not Team)
  const activeHref = items.filter((i) => isActive(pathname, i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col self-start border-r border-border bg-surface-1 md:flex">
      <Link href="/home" className="flex h-14 items-center gap-2.5 border-b border-border px-5">
        <Logo />
        <span className="text-[15px] font-semibold uppercase tracking-[0.08em] text-fg">Roundtable</span>
        <span className="ml-auto whitespace-nowrap rounded border border-border-strong px-1 text-[10px] uppercase tracking-wider text-muted">Sales OS</span>
      </Link>
      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
        {groups.map(({ g, items }) => {
          const label = NAV_GROUP_LABELS[g];
          const hasActive = items.some((i) => i.href === activeHref);
          const open = !label || hasActive || !collapsed.includes(g);
          const listId = `nav-group-${g}`;
          return (
            <div key={g} className={cn("mb-4", g === "system" && "mt-2 border-t border-border pt-3")}>
              {label ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation(); // the mobile drawer closes on any click inside it
                    if (!hasActive) toggle(g);
                  }}
                  aria-expanded={open}
                  aria-controls={listId}
                  className="group mb-1 flex w-full items-center rounded px-2 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                >
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted transition-colors group-hover:text-secondary">{label}</span>
                  {!open ? <span className="ml-1.5 text-[10px] text-muted tabular">{items.length}</span> : null}
                  <Icons.ChevronDown
                    className={cn("ml-auto size-3 text-muted opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100", !open && "-rotate-90 opacity-100")}
                    aria-hidden
                  />
                </button>
              ) : null}
              {open ? (
                <ul id={listId} className="space-y-0.5">
                  {items.map((item) => (
                    <NavLink key={item.href} item={item} active={item.href === activeHref} />
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
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
        {item.hint ? <kbd className="ml-auto hidden rounded border border-border-strong px-1 text-[10px] font-normal text-muted lg:inline">{item.hint}</kbd> : null}
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
