"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type PickedDeal = { id: string; name: string; subtitle?: string };

/**
 * Deal search (uses /api/search, which is already permission-scoped by dealAccessWhere).
 * Exported for reuse (inbox link dialog, transcript upload/attach, composer).
 */
export function DealPicker({
  value,
  onChange,
  placeholder = "Search deals…",
  label = "Deal",
  className,
}: {
  value: PickedDeal | null;
  onChange: (d: PickedDeal | null) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PickedDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        const json = (await res.json()) as { hits?: { type: string; id: string; title: string; subtitle?: string }[] };
        setHits((json.hits ?? []).filter((h) => h.type === "deal").map((h) => ({ id: h.id, name: h.title, subtitle: h.subtitle })));
        setActive(0);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  if (value) {
    return (
      <div className={cn("space-y-1.5", className)}>
        <p className="text-xs font-medium text-secondary">{label}</p>
        <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 text-sm">
          <span className="truncate text-fg">
            {value.name}
            {value.subtitle ? <span className="ml-2 text-xs text-muted">{value.subtitle}</span> : null}
          </span>
          <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-muted hover:text-fg" aria-label="Clear deal">
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const list = q.trim().length >= 2 ? hits : [];
  return (
    <div className={cn("relative space-y-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-secondary">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
        <Input
          id={id}
          value={q}
          placeholder={placeholder}
          className="pl-8"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && list.length > 0}
          aria-controls={`${id}-list`}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!list.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              onChange(list[active]!);
              setQ("");
            }
          }}
        />
        {loading ? <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted" aria-hidden /> : null}
      </div>
      {open && q.trim().length >= 2 ? (
        <ul id={`${id}-list`} role="listbox" className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border-strong bg-surface-2 p-1">
          {list.length === 0 && !loading ? <li className="px-2 py-1.5 text-xs text-muted">No deals you can access match “{q}”.</li> : null}
          {list.map((d, i) => (
            <li
              key={d.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(d);
                setQ("");
              }}
              className={cn("flex cursor-pointer items-center justify-between rounded px-2 py-1.5 text-sm", i === active ? "bg-surface-3 text-fg" : "text-body")}
            >
              <span className="truncate">{d.name}</span>
              {d.subtitle ? <span className="ml-2 shrink-0 text-[11px] text-muted">{d.subtitle}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
