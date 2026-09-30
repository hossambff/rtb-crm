import Link from "next/link";
import { Lock, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EMAIL_INTENTS } from "@/lib/gmail/analysis-core";

export type InboxParams = Partial<Record<"awaiting" | "intent" | "linked" | "mailbox" | "view" | "q" | "thread", string>>;

export function inboxHref(params: InboxParams, patch: InboxParams): string {
  const next = { ...params, ...patch };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/inbox?${s}` : "/inbox";
}

export const INTENT_LABELS: Record<string, string> = {
  interested: "Interested",
  objection: "Objection",
  scheduling: "Scheduling",
  legal: "Contract / legal",
  pricing: "Pricing",
  not_interested: "Not interested",
  ooo: "Out of office",
  referral: "Referral",
  other: "Other",
};

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs transition-colors",
        active ? "border-white bg-white text-black" : "border-border-strong text-secondary hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

export function InboxFilters({ params, counts, canSeeTeam }: { params: InboxParams; counts: { us: number; them: number; unlinked: number }; canSeeTeam: boolean }) {
  const clear = { thread: undefined };
  const isAll = !params.awaiting && !params.linked && params.view !== "private";
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip href={inboxHref(params, { ...clear, awaiting: undefined, linked: undefined, view: undefined })} active={isAll}>
          All
        </Chip>
        <Chip href={inboxHref(params, { ...clear, awaiting: "us", view: undefined })} active={params.awaiting === "us"}>
          Reply owed <span className="tabular opacity-70">{counts.us}</span>
        </Chip>
        <Chip href={inboxHref(params, { ...clear, awaiting: "them", view: undefined })} active={params.awaiting === "them"}>
          Waiting on them <span className="tabular opacity-70">{counts.them}</span>
        </Chip>
        <Chip href={inboxHref(params, { ...clear, linked: params.linked === "unlinked" ? undefined : "unlinked", view: undefined })} active={params.linked === "unlinked"}>
          No deal <span className="tabular opacity-70">{counts.unlinked}</span>
        </Chip>
        <Chip href={inboxHref(params, { ...clear, linked: params.linked === "linked" ? undefined : "linked", view: undefined })} active={params.linked === "linked"}>
          Linked to a deal
        </Chip>
        <Chip href={inboxHref({}, { view: params.view === "private" ? undefined : "private" })} active={params.view === "private"}>
          <Lock className="size-3" aria-hidden /> Private
        </Chip>
      </div>
      <form action="/inbox" className="flex flex-wrap items-center gap-2" role="search">
        {params.awaiting ? <input type="hidden" name="awaiting" value={params.awaiting} /> : null}
        {params.linked ? <input type="hidden" name="linked" value={params.linked} /> : null}
        <div className="relative min-w-52 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search subject or people"
            aria-label="Search threads"
            className="h-8 w-full rounded-md border border-border bg-surface-3/40 pl-8 pr-3 text-sm text-body placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          />
        </div>
        <select
          name="intent"
          defaultValue={params.intent ?? ""}
          aria-label="Filter by intent"
          className="h-8 rounded-md border border-border bg-surface-2 px-2 text-xs text-body"
        >
          <option value="">Any intent</option>
          {EMAIL_INTENTS.map((i) => (
            <option key={i} value={i}>
              {INTENT_LABELS[i]}
            </option>
          ))}
        </select>
        {canSeeTeam ? (
          <select name="mailbox" defaultValue={params.mailbox ?? ""} aria-label="Mailbox" className="h-8 rounded-md border border-border bg-surface-2 px-2 text-xs text-body">
            <option value="">My + team (linked)</option>
            <option value="mine">My mailbox</option>
            <option value="team">Team (linked deals)</option>
          </select>
        ) : null}
        <button type="submit" className="h-8 rounded-md border border-border-strong px-3 text-xs text-fg hover:bg-surface-2">
          Apply
        </button>
      </form>
    </div>
  );
}
