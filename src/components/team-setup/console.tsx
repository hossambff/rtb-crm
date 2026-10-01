"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Team setup tabs (client): Progress · Invite · Claims · Quotas. Panels are rendered on the server and passed in. */
export function TeamSetupTabs({
  tabs,
}: {
  tabs: { key: string; label: string; count?: number; panel: React.ReactNode }[];
}) {
  return (
    <Tabs defaultValue={tabs[0]?.key}>
      <TabsList className="overflow-x-auto overflow-y-hidden">
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key} className="whitespace-nowrap">
            {t.label}
            {t.count ? <span className="ml-1.5 text-xs text-muted tabular">{t.count}</span> : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key}>
          {t.panel}
        </TabsContent>
      ))}
    </Tabs>
  );
}
