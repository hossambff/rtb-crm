"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { DEAL_TABS, type DealTab } from "./deal-tab-keys";

const LABEL: Record<DealTab, string> = { activity: "Activity", tasks: "Tasks", contacts: "Contacts", docs: "Docs & proposals", details: "Details", discussion: "Discussion" };

/**
 * Deal page tabs (V2 §B6). Panels are server-rendered and passed in; the active tab is mirrored to `?tab=` so links from
 * notifications ("…?tab=discussion#c-…") and reloads land in the right place.
 *
 * Perf H-4: `lazyTabs` have heavy parts the server renders only for the tab it was asked for (`initial`). Switching to
 * one of them re-requests the page with the new `?tab=` (a soft navigation — the light content shows immediately, the
 * heavy part streams in). Other tabs only update the URL (replaceState, no request).
 */
export function DealTabs({
  initial,
  counts,
  panels,
  lazyTabs = [],
}: {
  initial: DealTab;
  counts: Partial<Record<DealTab, number>>;
  panels: Record<DealTab, React.ReactNode>;
  lazyTabs?: DealTab[];
}) {
  const [tab, setTab] = React.useState<DealTab>(initial);
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const change = (v: string) => {
    const next = (DEAL_TABS as readonly string[]).includes(v) ? (v as DealTab) : "activity";
    setTab(next);
    try {
      const url = new URL(window.location.href);
      if (next === "activity") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      url.hash = "";
      if (lazyTabs.includes(next) && next !== initial) startTransition(() => router.replace(`${url.pathname}${url.search}`, { scroll: false }));
      else window.history.replaceState(window.history.state, "", url);
    } catch {
      /* non-critical */
    }
  };
  return (
    <Tabs value={tab} onValueChange={change} className="min-w-0">
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <TabsList aria-label="Deal sections" className="w-max min-w-full">
          {DEAL_TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="whitespace-nowrap">
              {LABEL[t]}
              {counts[t] ? <span className="ml-1.5 text-[11px] font-normal text-muted tabular">{counts[t]}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {DEAL_TABS.map((t) => (
        <TabsContent key={t} value={t} forceMount className="data-[state=inactive]:hidden">
          {panels[t]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
