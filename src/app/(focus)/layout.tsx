import { requireUser } from "@/lib/rbac/server";

/**
 * Focus frame: authenticated pages without the sidebar shell (team onboarding at /welcome). A minimal branded header; the
 * page owns its own actions ("Finish later").
 */
export default async function FocusLayout({ children }: LayoutProps<"/">) {
  await requireUser();
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4 md:px-8">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark, already optimized */}
        <img src="/brand/roundtable-mark-white.png" width={22} height={22} alt="" aria-hidden className="shrink-0" />
        <span className="font-display text-[17px] leading-none tracking-wide text-fg">Roundtable</span>
        <span className="ml-1 hidden text-xs text-muted sm:inline">Sales OS</span>
      </header>
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
