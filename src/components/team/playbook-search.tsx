"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/** Debounced search box that writes ?q= (keeps the other params). */
export function PlaybookSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(initial);

  useEffect(() => {
    const current = params.get("q") ?? "";
    if (q.trim() === current) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }, 300);
    return () => clearTimeout(t);
  }, [q, params, pathname, router]);

  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the playbook" aria-label="Search the playbook" className="pl-8" />
    </div>
  );
}
