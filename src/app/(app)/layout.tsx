import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { unreadCount } from "@/lib/notifications/queries";
import { requireUser } from "@/lib/rbac/server";
import { visibleNav } from "@/lib/rbac/nav-server";
import { ROLE_LABELS } from "@/lib/rbac/model";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { getPrefs } from "@/lib/prefs";
import { shouldRedirectToWelcome, type OnboardingState } from "@/lib/welcome/core";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  // First run (team onboarding): people who never started setup go to /welcome. lastActiveAt is read BEFORE the stamp
  // below: accounts created before the wizard shipped that already used the app count as deferred (rule and exempt
  // paths: shouldRedirectToWelcome in src/lib/welcome/core.ts). Prefs are cached per request; one small user-row read.
  const [prefs, [activity], path] = await Promise.all([
    getPrefs(user.id),
    db.select({ createdAt: userTable.createdAt, lastActiveAt: userTable.lastActiveAt }).from(userTable).where(eq(userTable.id, user.id)),
    headers().then((h) => h.get("x-rso-pathname") ?? ""),
  ]);
  if (
    shouldRedirectToWelcome({
      path,
      state: prefs.onboarding as OnboardingState,
      impersonating: Boolean(user.impersonatedBy),
      createdAt: activity?.createdAt ?? null,
      lastActiveAt: activity?.lastActiveAt ?? null,
      role: user.role,
    })
  )
    redirect("/welcome");
  // bell count excludes digest-only rows (V2 alert budget)
  const [nav, n] = await Promise.all([visibleNav(user), unreadCount(user)]);
  // best-effort activity stamp (no await on the render path's critical data)
  void db.update(userTable).set({ lastActiveAt: new Date() }).where(eq(userTable.id, user.id)).catch(() => {});
  return (
    <div className="flex min-h-screen overflow-x-clip bg-bg">
      <Sidebar items={nav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={{ name: user.name, email: user.email, image: user.image }}
          roleLabel={ROLE_LABELS[user.role]}
          unread={n}
          nav={nav}
          impersonating={Boolean(user.impersonatedBy)}
        />
        <main className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
