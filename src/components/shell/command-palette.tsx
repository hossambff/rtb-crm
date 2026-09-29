"use client";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import * as Icons from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { NavItem } from "@/lib/nav";

type Hit = { type: "deal" | "account" | "contact"; id: string; title: string; subtitle?: string; href: string };

export function CommandPalette({ open, onOpenChange, nav }: { open: boolean; onOpenChange: (o: boolean) => void; nav: NavItem[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) setHits((await res.json()).hits ?? []);
      } catch {
        /* aborted */
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const go = (href: string) => {
    onOpenChange(false);
    setQ("");
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-xl translate-y-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command shouldFilter={false} className="text-sm">
          <Command.Input
            value={q}
            onValueChange={setQ}
            placeholder="Search or type a command…"
            className="h-12 w-full border-b border-border bg-transparent px-4 text-body outline-none placeholder:text-muted"
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-muted">No results.</Command.Empty>
            {q.trim().length >= 2 && hits.length ? (
              <Command.Group heading="Records" className="text-[11px] text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                {hits.map((h) => (
                  <Command.Item
                    key={`${h.type}:${h.id}`}
                    value={`${h.type}:${h.id}`}
                    onSelect={() => go(h.href)}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-body data-[selected=true]:bg-surface-3"
                  >
                    <span className="w-16 text-[10px] uppercase tracking-wider text-muted">{h.type}</span>
                    <span className="truncate">{h.title}</span>
                    {h.subtitle ? <span className="ml-auto truncate text-xs text-muted">{h.subtitle}</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {q.trim().length >= 3 ? (
              <Command.Group heading="Copilot" className="text-[11px] text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                <Command.Item
                  value="ask-copilot"
                  onSelect={() => go(`/copilot?q=${encodeURIComponent(q)}`)}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-body data-[selected=true]:bg-surface-3"
                >
                  <Icons.Sparkles className="size-4 text-muted" /> Ask Copilot: “{q}”
                </Command.Item>
              </Command.Group>
            ) : null}
            <Command.Group heading="Go to" className="text-[11px] text-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
              {nav
                .filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase()))
                .map((n) => {
                  const Icon = (Icons as unknown as Record<string, Icons.LucideIcon>)[n.icon] ?? Icons.Circle;
                  return (
                    <Command.Item
                      key={n.href}
                      value={n.href}
                      onSelect={() => go(n.href)}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-body data-[selected=true]:bg-surface-3"
                    >
                      <Icon className="size-4 text-muted" strokeWidth={1.5} /> {n.label}
                    </Command.Item>
                  );
                })}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
