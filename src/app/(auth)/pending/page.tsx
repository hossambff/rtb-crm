import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac/server";
import { Logo } from "@/components/shell/sidebar";
import { SignOutButton } from "./sign-out-button";

export const metadata = { title: "Awaiting access" };

export default async function PendingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "pending") redirect("/home");
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <Logo size={36} />
        </div>
        <h1 className="font-display text-[28px] leading-9 text-fg">You&apos;re in the queue</h1>
        <p className="mt-3 text-sm text-muted">
          Signed in as <span className="text-fg">{user.email}</span>. An admin needs to assign your role before you can access Roundtable Sales OS.
        </p>
        <div className="mt-6 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
