"use client";
import { usePathname, useRouter } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export const MASKS = [
  { key: "revShare", label: "Revenue share (TBD)" },
  { key: "guarantee", label: "Guarantee amount" },
  { key: "terms", label: "Ramp & term" },
  { key: "multiYear", label: "Multi-year view" },
] as const;

/** Toolbar (hidden in print): TBD masking toggles (PRO-4) + print. State lives in ?mask=… so the URL is shareable. */
export function MaskControls({ active }: { active: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const toggle = (key: string) => {
    const next = active.includes(key) ? active.filter((k) => k !== key) : [...active, key];
    router.replace(`${pathname}?mask=${encodeURIComponent(next.join(",") || "none")}`, { scroll: false });
  };
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
      <span className="text-xs font-medium text-secondary">Print as TBD:</span>
      {MASKS.map((m) => (
        <label key={m.key} className="inline-flex items-center gap-1.5 text-sm text-body">
          <input type="checkbox" className="size-4 accent-white" checked={active.includes(m.key)} onChange={() => toggle(m.key)} />
          {m.label}
        </label>
      ))}
      <Button variant="primary" className="ml-auto" onClick={() => window.print()}>
        <Printer /> Print / Save as PDF
      </Button>
    </div>
  );
}
