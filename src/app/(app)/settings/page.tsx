import { Suspense } from "react";
import { requireUser } from "@/lib/rbac/server";
import { GOOGLE_WORKSPACE_SCOPES } from "@/lib/auth";
import { getSettingsState } from "@/lib/integrations/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/misc";
import { ProfileForm } from "@/components/settings/profile-form";
import { GoogleConnection } from "@/components/settings/google-connection";
import { GranolaForm } from "@/components/settings/granola-form";
import { ZoomForm } from "@/components/settings/zoom-form";
import { BlocklistForm, NotificationForm } from "@/components/settings/preferences-forms";
import { MailboxBanner } from "@/components/settings/mailbox-banner";

export const metadata = { title: "Settings" };

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "connections", label: "Connections" },
  { id: "notifications", label: "Notifications" },
  { id: "privacy", label: "Privacy" },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const state = await getSettingsState(user);
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];
  }
  if (state.profile.timezone && !zones.includes(state.profile.timezone)) zones = [state.profile.timezone, ...zones];
  const showBanner = state.mailboxRequired && !state.google.gmailRead;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" description="Your profile, connected accounts, notifications and privacy." />
      <nav aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {SECTIONS.map((sct) => (
          <a key={sct.id} href={`#${sct.id}`} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:border-border-strong hover:text-fg">
            {sct.label}
          </a>
        ))}
      </nav>
      <div className="space-y-6">
        {showBanner ? <MailboxBanner /> : null}

        <Card id="profile" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Timezone and working hours drive SLA timers and quiet hours.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ProfileForm profile={state.profile} zones={zones} />
          </CardContent>
        </Card>

        <Card id="connections" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Connections</CardTitle>
              <CardDescription>Keys and tokens are encrypted at rest and never shown again after saving.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-border p-0">
            <div className="px-5 py-5">
              <Suspense>
                <GoogleConnection state={state.google} scopes={GOOGLE_WORKSPACE_SCOPES} required={state.mailboxRequired} />
              </Suspense>
            </div>
            <div className="px-5 py-5">
              <GranolaForm conn={state.granola} />
            </div>
            {state.zoom ? (
              <div className="px-5 py-5">
                <ZoomForm state={state.zoom} />
              </div>
            ) : (
              <div className="px-5 py-4 text-xs text-muted">Zoom is connected once for the whole organization by an admin; transcripts of your cloud recordings arrive automatically.</div>
            )}
          </CardContent>
        </Card>

        <Card id="notifications" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Notifications &amp; email</CardTitle>
              <CardDescription>How and when Roundtable reaches you.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <NotificationForm prefs={state.prefs} />
          </CardContent>
        </Card>

        <Card id="privacy" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Privacy</CardTitle>
              <CardDescription>Personal threads are never visible to anyone. You can also mark any thread private from the Inbox.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <BlocklistForm entries={state.prefs.blocklist} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
