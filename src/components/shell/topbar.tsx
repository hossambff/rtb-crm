"use client";
import Link from "next/link";
import { Bell, Columns3, ListChecks, LogOut, Menu, Search, Settings, ShieldAlert, Sparkles, Sun } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sidebar } from "./sidebar";
import type { NavItem } from "@/lib/nav";
import { CommandPalette } from "./command-palette";
import { CopilotLauncher, openCopilot } from "./copilot-launcher";
import { CaptureButton } from "@/components/capture/capture-button";
import { ModKey } from "@/components/ui/mod-key";

export function Topbar({
  user,
  roleLabel,
  unread,
  nav,
  impersonating,
}: {
  user: { name: string; email: string; image: string | null };
  roleLabel: string;
  unread: number;
  nav: NavItem[];
  impersonating: boolean;
}) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const canCopilot = nav.some((i) => i.href === "/copilot");

  return (
    <>
      {impersonating ? (
        <div className="flex items-center justify-center gap-2 border-b border-border bg-surface-2 py-1.5 text-xs text-fg">
          <ShieldAlert className="size-3.5 text-warning" /> You are viewing as {user.name}. All actions are audit-logged.
          <button
            className="underline"
            onClick={async () => {
              await authClient.admin.stopImpersonating();
              router.push("/admin/users");
              router.refresh();
            }}
          >
            Stop
          </button>
        </div>
      ) : null}
      <header className="sticky top-0 z-30 flex h-14 min-w-0 items-center gap-2 border-b border-border bg-bg/95 px-4 backdrop-blur md:px-6">
        <Link href="/home" className="flex shrink-0 items-center md:hidden" aria-label="Roundtable — My Day">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/roundtable-mark-white.png" width={22} height={22} alt="" aria-hidden />
        </Link>
        <button
          onClick={() => setPaletteOpen(true)}
          className="hidden h-9 min-w-0 flex-1 max-w-md items-center gap-2 rounded-md border border-border bg-surface-1 px-3 text-sm text-muted hover:border-border-strong sm:flex"
          aria-label="Search or run a command"
        >
          <Search className="size-4 shrink-0" strokeWidth={1.5} />
          <span className="min-w-0 truncate">Search deals, accounts, contacts, or ask Copilot…</span>
          <kbd className="ml-auto hidden rounded border border-border-strong px-1.5 text-[10px] text-muted md:inline">
            <ModKey then="K" />
          </kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search or run a command" onClick={() => setPaletteOpen(true)}>
            <Search strokeWidth={1.5} />
          </Button>
          {canCopilot ? (
            <Button variant="ghost" size="icon" aria-label="Ask Copilot (⌘J)" title="Ask Copilot (⌘J)" onClick={() => openCopilot()}>
              <Sparkles strokeWidth={1.5} />
            </Button>
          ) : null}
          <CaptureButton />
          <Button variant="ghost" size="icon" asChild aria-label={`Notifications (${unread} unread)`}>
            <Link href="/tasks?tab=notifications" className="relative">
              <Bell strokeWidth={1.5} />
              {unread > 0 ? (
                <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-fg px-1 text-center text-[10px] font-semibold leading-4 text-accent-inverse">
                  {unread > 99 ? "99+" : unread}
                </span>
              ) : null}
            </Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2 sm:px-2" aria-label="Account menu">
              <Avatar name={user.name} src={user.image} size={28} />
              <span className="hidden text-left leading-tight lg:block">
                <span className="block text-sm font-medium text-fg">{user.name}</span>
                <span className="block text-[11px] text-muted">{roleLabel}</span>
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5 text-xs text-muted">{user.email}</div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/settings")}>
                <Settings /> Settings & connections
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  await authClient.signOut();
                  router.push("/sign-in");
                  router.refresh();
                }}
              >
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent side="right" className="max-w-64 p-0" onClick={() => setMobileOpen(false)}>
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Sidebar items={nav} variant="drawer" />
        </DialogContent>
      </Dialog>
      <MobileTabBar nav={nav} onMenu={() => setMobileOpen(true)} canCopilot={canCopilot} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} nav={nav} />
      {canCopilot ? <CopilotLauncher /> : null}
    </>
  );
}

/**
 * Phone navigation (< md): the four destinations people hit most, one tap away, plus Menu for the full sidebar.
 * Sits above the home indicator (safe-area inset); hidden from md where the sidebar takes over.
 */
function MobileTabBar({ nav, onMenu, canCopilot }: { nav: NavItem[]; onMenu: () => void; canCopilot: boolean }) {
  const pathname = usePathname();
  const has = (href: string) => nav.some((i) => i.href === href);
  const tabs = [
    { href: "/home", label: "My Day", icon: Sun, show: true },
    { href: "/pipelines", label: "Pipelines", icon: Columns3, show: has("/pipelines") },
    { href: "/tasks", label: "Tasks", icon: ListChecks, show: has("/tasks") },
  ].filter((t) => t.show);
  const item = "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors";
  return (
    <nav
      aria-label="Quick navigation"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn(item, active ? "text-fg" : "text-muted")}>
            <t.icon className="size-5" strokeWidth={1.5} aria-hidden />
            <span className="truncate">{t.label}</span>
          </Link>
        );
      })}
      {canCopilot ? (
        <button type="button" onClick={() => openCopilot()} className={cn(item, "text-muted")}>
          <Sparkles className="size-5" strokeWidth={1.5} aria-hidden />
          <span>Copilot</span>
        </button>
      ) : null}
      <button type="button" onClick={onMenu} className={cn(item, "text-muted")} aria-label="Open navigation">
        <Menu className="size-5" strokeWidth={1.5} aria-hidden />
        <span>Menu</span>
      </button>
    </nav>
  );
}
