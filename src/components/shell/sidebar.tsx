"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Tooltip } from "@/components/ui/misc";
import { SIDEBAR_COOKIE, type SidebarMode } from "@/lib/sidebar";
import { ModKey } from "@/components/ui/mod-key";
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
 * Static class sets per mode (Tailwind needs literal class names). "auto" = icon rail on tablets (md), full sidebar
 * from lg; "collapsed" = icon rail everywhere; "expanded" = full sidebar everywhere.
 */
const CLS = {
  width: { expanded: "w-60", collapsed: "w-16", auto: "w-16 lg:w-60" },
  label: { expanded: "", collapsed: "sr-only", auto: "sr-only lg:not-sr-only" },
  wordmark: { expanded: "flex", collapsed: "hidden", auto: "hidden lg:flex" },
  brand: { expanded: "px-5", collapsed: "justify-center px-0", auto: "justify-center px-0 lg:justify-start lg:px-5" },
  groupHeader: { expanded: "flex", collapsed: "hidden", auto: "hidden lg:flex" },
  railDivider: { expanded: "hidden", collapsed: "block", auto: "block lg:hidden" },
  closedList: { expanded: "hidden", collapsed: "", auto: "lg:hidden" },
  link: { expanded: "px-2", collapsed: "justify-center px-0", auto: "justify-center px-0 lg:justify-start lg:px-2" },
  hint: { expanded: "lg:inline", collapsed: "", auto: "lg:inline" },
  navPad: { expanded: "px-3", collapsed: "px-2", auto: "px-2 lg:px-3" },
  tip: { expanded: "hidden", collapsed: "", auto: "lg:hidden" },
} as const;

/**
 * Left navigation, grouped by intent (My Day + Copilot + Tasks on top, then Sell, Engage, Programs, Insights, System).
 * Every permitted item is visible — no "More" menu. Collapses to an icon rail (header button or ⌘\; closed by default); groups
 * collapse too (remembered per browser), and the group holding the current page always stays open.
 * `variant="drawer"` renders the full list inside the mobile navigation sheet.
 */
export function Sidebar({ items, mode: initialMode = "collapsed", variant = "desktop" }: { items: NavItem[]; mode?: SidebarMode; variant?: "desktop" | "drawer" }) {
  const pathname = usePathname();
  const [modeState, setModeState] = useState<SidebarMode>(initialMode);
  const mode: SidebarMode = variant === "drawer" ? "expanded" : modeState;
  // remembered per browser; the server render uses the default, so hydration matches
  const raw = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_RAW);
  const collapsed = useMemo(() => parseCollapsed(raw), [raw]);
  const toggle = (g: NavGroup) => writeCollapsed(collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g]);
  const groups = NAV_GROUPS.map((g) => ({ g, items: items.filter((i) => i.group === g) })).filter((x) => x.items.length);
  // only the most specific match is "current" (e.g. /team/setup highlights Team setup, not Team)
  const activeHref = items.filter((i) => isActive(pathname, i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;

  const toggleRail = useCallback(() => {
    setModeState((m) => {
      // "auto" → flip whatever is showing right now (rail below lg, full from lg)
      const showingRail = m === "collapsed" || (m === "auto" && !window.matchMedia("(min-width: 1024px)").matches);
      const next: SidebarMode = showingRail ? "expanded" : "collapsed";
      document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);
  useEffect(() => {
    if (variant === "drawer") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail, variant]);

  return (
    <aside
      data-mode={mode}
      className={cn(
        "sticky top-0 h-screen shrink-0 flex-col self-start border-r border-border bg-surface-1 transition-[width] duration-200",
        variant === "drawer" ? "flex w-full border-0" : cn("hidden md:flex", CLS.width[mode]),
      )}
    >
      {variant === "drawer" || mode === "expanded" ? (
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border pl-5 pr-3">
          <Link href="/home" className="flex min-w-0 flex-1 items-center gap-2.5" aria-label="Roundtable — My Day">
            <Logo />
            <span className="truncate text-[15px] font-semibold uppercase tracking-[0.08em] text-fg">Roundtable</span>
          </Link>
          {variant === "desktop" ? (
            <Tooltip content={<>Collapse sidebar <ModKey then="\\" /></>} side="right">
              <button
                type="button"
                onClick={toggleRail}
                aria-label="Collapse sidebar"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
              >
                <Icons.PanelLeftClose className="size-4" strokeWidth={1.5} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : (
        // icon rail: the Roundtable mark doubles as the expand button (shows the expand icon on hover / focus)
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
          <Tooltip content={<>Expand sidebar <ModKey then="\\" /></>} side="right">
            <button
              type="button"
              onClick={toggleRail}
              aria-label="Expand sidebar"
              className="group/expand relative flex size-9 items-center justify-center rounded-md transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              <span className="transition-opacity duration-150 group-hover/expand:opacity-0 group-focus-visible/expand:opacity-0">
                <Logo />
              </span>
              <Icons.PanelLeftOpen
                className="absolute size-4 text-fg opacity-0 transition-opacity duration-150 group-hover/expand:opacity-100 group-focus-visible/expand:opacity-100"
                strokeWidth={1.5}
                aria-hidden
              />
            </button>
          </Tooltip>
        </div>
      )}
      <nav className={cn("flex-1 overflow-y-auto overflow-x-hidden py-4", CLS.navPad[mode])} aria-label="Main">
        {groups.map(({ g, items }, gi) => {
          const label = NAV_GROUP_LABELS[g];
          const hasActive = items.some((i) => i.href === activeHref);
          const open = !label || hasActive || !collapsed.includes(g);
          const listId = `nav-group-${g}-${variant}`;
          return (
            <div key={g} className={cn("mb-4", g === "system" && "mt-2 border-t border-border pt-3")}>
              {label ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation(); // the mobile drawer closes on any click inside it
                      if (!hasActive) toggle(g);
                    }}
                    aria-expanded={open}
                    aria-controls={listId}
                    className={cn(
                      "group mb-1 w-full items-center rounded px-2 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
                      CLS.groupHeader[mode],
                    )}
                  >
                    <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted transition-colors group-hover:text-secondary">{label}</span>
                    {!open ? <span className="ml-1.5 text-[10px] text-muted tabular">{items.length}</span> : null}
                    <Icons.ChevronDown
                      className={cn("ml-auto size-3 text-muted opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100", !open && "-rotate-90 opacity-100")}
                      aria-hidden
                    />
                  </button>
                  {gi > 0 && g !== "system" ? <div className={cn("mx-auto mb-2 h-px w-6 bg-border", CLS.railDivider[mode])} aria-hidden /> : null}
                </>
              ) : null}
              {/* a collapsed group stays visible in the icon rail (it has no headers to reopen it) */}
              <ul id={listId} className={cn("space-y-0.5", !open && CLS.closedList[mode])}>
                {items.map((item) => (
                  <NavLink key={item.href} item={item} active={item.href === activeHref} mode={mode} />
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function NavLink({ item, active, mode }: { item: NavItem; active: boolean; mode: SidebarMode }) {
  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[item.icon] ?? Icons.Circle;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md py-1.5 text-sm transition-colors",
        CLS.link[mode],
        active ? "bg-surface-2 text-fg" : "text-secondary hover:bg-surface-2/60 hover:text-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-fg" : "text-muted")} strokeWidth={1.5} aria-hidden />
      <span className={cn("truncate", active && "font-medium", CLS.label[mode])}>{item.label}</span>
      {item.hint ? <kbd className={cn("ml-auto hidden rounded border border-border-strong px-1 text-[10px] font-normal text-muted", CLS.hint[mode])}>{item.hint}</kbd> : null}
    </Link>
  );
  if (mode === "expanded") return <li>{link}</li>;
  // icon rail: the label lives in a tooltip (hidden again from lg in "auto", where the full label shows)
  return (
    <li>
      <Tooltip content={item.label} side="right" contentClassName={CLS.tip[mode]}>
        {link}
      </Tooltip>
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
