import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { unreadCount } from "@/lib/notifications/queries";
import { requireUser } from "@/lib/rbac/server";
import { visibleNav } from "@/lib/rbac/nav-server";
import { ROLE_LABELS } from "@/lib/rbac/model";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
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
