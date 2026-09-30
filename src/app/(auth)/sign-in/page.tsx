import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/rbac/server";
import { env } from "@/lib/env";
import { Logo, LogoLockup } from "@/components/shell/sidebar";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const user = await getCurrentUser();
  if (user) redirect(user.role === "pending" ? "/pending" : "/home");
  const sp = await searchParams;
  const error = typeof sp.error === "string" ? sp.error : undefined;
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between border-r border-border bg-surface-1 p-12 lg:flex">
        <LogoLockup height={112} />
        <div>
          <p className="font-display text-[40px] leading-[48px] text-fg">
            Nothing slips.
            <br />
            <span className="italic text-secondary">Every deal, every promise, every follow-up.</span>
          </p>
          <p className="mt-6 max-w-md text-sm text-muted">
            The sales operating system for RTB&apos;s publisher network, enterprise media partnerships, Roundtable 100 and TheStreet sponsorships.
          </p>
        </div>
        <p className="text-xs text-muted">RTB Digital, Inc. · Internal use only</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo size={32} />
            <span className="text-lg font-semibold uppercase tracking-[0.08em] text-fg">Roundtable</span>
          </div>
          <h1 className="font-display text-[28px] leading-9 text-fg">Sign in</h1>
          <p className="mt-2 text-sm text-muted">Use your roundtable.io or blockchainff.com Google account.</p>
          {error ? (
            <p role="alert" className="mt-4 rounded-md border border-border-strong bg-surface-2 px-3 py-2 text-sm text-fg">
              {error === "unable_to_create_user" || error === "FORBIDDEN"
                ? "That account isn't allowed. Only roundtable.io and blockchainff.com accounts can sign in."
                : "Sign-in failed. Please try again."}
            </p>
          ) : null}
          <SignInForm googleEnabled={env.googleConfigured} devLoginEnabled={env.devLoginEnabled} />
        </div>
      </div>
    </div>
  );
}
