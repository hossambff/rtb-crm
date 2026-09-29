"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export function SignInForm({ googleEnabled, devLoginEnabled }: { googleEnabled: boolean; devLoginEnabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="mt-8 space-y-6">
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={!googleEnabled || busy}
        onClick={async () => {
          setBusy(true);
          await authClient.signIn.social({ provider: "google", callbackURL: "/home", errorCallbackURL: "/sign-in" });
        }}
      >
        <GoogleMark /> Continue with Google
      </Button>
      {!googleEnabled ? (
        <p className="text-xs text-muted">Google sign-in isn&apos;t configured yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).</p>
      ) : null}

      {devLoginEnabled ? (
        <form
          className="space-y-3 rounded-lg border border-dashed border-border-strong p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const { error } = await authClient.signIn.email({ email, password });
            setBusy(false);
            if (error) {
              toast.error(error.message ?? "Sign-in failed");
              return;
            }
            router.push("/home");
            router.refresh();
          }}
        >
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Developer sign-in (local only)</p>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            Sign in
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#0b0b0b" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" />
    </svg>
  );
}
