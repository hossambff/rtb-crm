"use client";
import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CreateDealButton } from "@/components/deals/create-deal-dialog";
import { listHref } from "@/lib/views/core";

/**
 * "New deal" for /deals that opens itself when `?create=1` is in the URL (⌘K "Create deal" lands on /deals?create=1),
 * via CreateDealButton's `defaultOpen`, then drops the param (the dialog stays open — its state is local).
 */
export function AutoOpenCreateDeal(props: React.ComponentProps<typeof CreateDealButton>) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const want = sp.get("create") === "1";
  React.useEffect(() => {
    if (!want) return;
    const next = new URLSearchParams(sp.toString());
    next.delete("create");
    router.replace(listHref(pathname, next.toString()), { scroll: false });
  }, [want, sp, router, pathname]);
  return <CreateDealButton {...props} defaultOpen={want} />;
}
