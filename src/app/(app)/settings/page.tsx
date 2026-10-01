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
import { PreferencesSection } from "@/components/settings/preferences-section";
import { ChecklistRestoreButton } from "@/components/onboarding-checklist/checklist-card";
import { getSlackContext } from "@/lib/slack/config";
import { HOME_PAGE_NAME } from "@/lib/nav";
import { getMyMotions, getPrefs as getUserPrefs } from "@/lib/prefs";
import { permittedNav, visibleNav } from "@/lib/rbac/nav-server";
import { loadChecklist } from "@/lib/prefs/checklist";

export const metadata = { title: "Settings" };

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "connections", label: "Connections" },
  { id: "preferences", label: "Preferences" },
  { id: "email", label: "Email & drafting" },
  { id: "privacy", label: "Privacy" },
];

export default async function SettingsPage() {
  const user = await requireUser();
  const [state, prefs, motions, nav, allNav, checklist, slack] = await Promise.all([
    getSettingsState(user),
    getUserPrefs(user.id),
    getMyMotions(user),
    visibleNav(user),
    permittedNav(user),
    loadChecklist(user),
    getSlackContext().catch(() => null),
  ]);
  const moreSet = new Set(nav.filter((n) => n.more).map((n) => n.href));
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
      <PageHeader title="Settings" description="Your profile, connected accounts, preferences, interruptions and privacy." />
      <nav aria-label="Settings sections" className="mb-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border">
        {SECTIONS.map((sct) => (
          <a key={sct.id} href={`#${sct.id}`} className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:border-border-strong hover:text-fg">
            {sct.label}
          </a>
        ))}
      </nav>
      <div className="space-y-6">
        {showBanner ? <MailboxBanner configured={state.google.configured} /> : null}

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
              <GoogleConnection state={state.google} scopes={GOOGLE_WORKSPACE_SCOPES} required={state.mailboxRequired} />
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

        <Card id="preferences" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Preferences</CardTitle>
              <CardDescription>Shape the app around how you work: what you sell, what you see, what may interrupt you and when.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <PreferencesSection
              motions={motions.permitted.map((m) => ({ key: m.key, name: m.name, color: m.color }))}
              pipelineKeys={prefs.pipelineKeys.filter((k) => motions.permitted.some((m) => m.key === k))}
              autoMotions={{ keys: motions.keys, source: motions.source }}
              nav={allNav.map((n) => ({ href: n.href, label: n.label, more: moreSet.has(n.href) }))}
              alertBudgetPerDay={prefs.alertBudgetPerDay}
              autopilot={{
                postCall: prefs.autopilot.postCall ?? "review",
                meetingBriefs: prefs.autopilot.meetingBriefs ?? true,
                emailSignals: prefs.autopilot.emailSignals ?? true,
                forecastSuggest: prefs.autopilot.forecastSuggest ?? true,
              }}
              slackDm={prefs.slackDm}
              slackUserId={prefs.slackUserId}
              slackConfigured={Boolean(slack)}
              interruptions={{
                minSeverity: state.prefs.notifications.minSeverity,
                quietHoursStart: state.prefs.notifications.quietHoursStart,
                quietHoursEnd: state.prefs.notifications.quietHoursEnd,
              }}
            />
          </CardContent>
        </Card>

        {/* The checklist lives on My Day; Settings only offers to bring it back (QA MIN-03 — no duplicate card). */}
        {checklist && !checklist.complete && checklist.dismissed ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <p className="text-sm text-body">
              Setup checklist: {checklist.done} of {checklist.total} done · hidden from {HOME_PAGE_NAME}.
            </p>
            <ChecklistRestoreButton />
          </div>
        ) : null}

        <Card id="email" className="scroll-mt-20">
          <CardHeader>
            <div>
              <CardTitle>Email &amp; drafting</CardTitle>
              <CardDescription>Your signature, the voice for drafted follow-ups, and AI-action notices.</CardDescription>
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
