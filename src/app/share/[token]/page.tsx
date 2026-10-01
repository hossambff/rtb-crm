import type { Metadata } from "next";
import { headers } from "next/headers";
import { StatusBadge } from "@/components/ui/badge";
import { hashShareToken, isPreviewBot, isWellFormedToken, SHARE_FIELD_LABELS, type ShareCard } from "@/lib/share/core";
import { allowShareView } from "@/lib/share/rate-limit";
import { resolvePublicShare } from "@/lib/share/service";
import { logServerError } from "@/lib/errors";

/**
 * Public, read-only partner view (docs/V2_SPEC.md §C10). Outside the authenticated app: no session, no client
 * components (nothing is serialized to the browser beyond this HTML), no internal IDs. Dynamic on every request
 * (headers()) so Next sends `Cache-Control: private, no-cache, no-store`; noindex + no-referrer via metadata.
 */
export const metadata: Metadata = {
  title: "Partner status · Roundtable",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
  referrer: "no-referrer",
  openGraph: null,
  twitter: null,
};

const STATUS: Record<ShareCard["status"], { status: "good" | "critical" | "warning" | "info"; label: string }> = {
  open: { status: "info", label: "In progress" },
  won: { status: "good", label: "Live" },
  lost: { status: "info", label: "Not proceeding" },
  hold: { status: "warning", label: "On hold" },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-10 flex items-center justify-between gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/roundtable-lockup-white.png" alt="Roundtable" width={47} height={48} style={{ width: 47, height: 48 }} className="object-contain" />
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted">Partner view</span>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="mt-12 border-t border-border pt-4 text-[11px] leading-5 text-muted">
        Read-only status shared by Roundtable. Confidential — please don’t forward this link.
      </footer>
    </main>
  );
}

function Unavailable({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <section className="rounded-lg border border-border bg-surface-1 px-6 py-14 text-center">
        <h1 className="font-display text-2xl text-fg">{title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{body}</p>
      </section>
    </Shell>
  );
}

const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));

function Card({ c }: { c: ShareCard }) {
  const st = STATUS[c.status];
  const rows: { k: string; v: string }[] = [];
  if (c.stage) rows.push({ k: SHARE_FIELD_LABELS.stage, v: c.stage });
  if (c.closeDate) rows.push({ k: SHARE_FIELD_LABELS.closeDate, v: c.closeDate });
  if (c.muu) rows.push({ k: "Audience", v: c.muu });
  if (c.owner) rows.push({ k: "Roundtable contact", v: c.owner });
  return (
    <li className="rounded-lg border border-border bg-surface-1 p-5 transition-colors duration-200 hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-words font-display text-lg leading-6 text-fg">{c.title}</h2>
        <StatusBadge status={st.status} label={st.label} className="shrink-0" />
      </div>
      {rows.length ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {rows.map((r) => (
            <div key={r.k} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted">{r.k}</dt>
              <dd className="mt-0.5 truncate text-sm text-body">{r.v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {c.nextStep ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">
            Next step{c.nextStepDue ? <span className="normal-case tracking-normal"> · {c.nextStepDue}</span> : null}
          </p>
          <p className="mt-1 text-sm leading-6 text-body">{c.nextStep}</p>
        </div>
      ) : null}
    </li>
  );
}

export default async function SharePage({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  const h = await headers();
  if (isPreviewBot(h.get("user-agent"))) {
    return <Unavailable title="Roundtable partner view" body="Open this link in a browser to see the latest status." />;
  }
  // Platform-set client IP first (Vercel overwrites these); a client-supplied X-Forwarded-For hop is the last resort.
  const ip = h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowShareView(ip, isWellFormedToken(token) ? hashShareToken(token).slice(0, 16) : "bad")) {
    return <Unavailable title="Too many requests" body="Please wait a minute and refresh the page." />;
  }
  let share: Awaited<ReturnType<typeof resolvePublicShare>> = null;
  try {
    share = await resolvePublicShare(token);
  } catch (e) {
    logServerError("share.resolve", e);
    return <Unavailable title="Something went wrong" body="Please try again in a moment." />;
  }
  if (!share) {
    return <Unavailable title="This link isn’t available" body="It may have expired or been turned off. Ask your Roundtable contact for a new one." />;
  }
  const counts = { open: 0, won: 0, lost: 0, hold: 0 };
  for (const c of share.cards) counts[c.status]++;
  return (
    <Shell>
      <section aria-labelledby="share-title">
        {share.partnerName ? <p className="text-xs uppercase tracking-[0.14em] text-muted">Prepared for {share.partnerName}</p> : null}
        <h1 id="share-title" className="mt-1 font-display text-3xl leading-tight text-fg sm:text-4xl">
          {share.label}
        </h1>
        <p className="mt-2 text-sm text-secondary">
          Status as of {fmtDate(share.asOf)} · link valid until {fmtDate(share.expiresAt)}
        </p>
        {share.cards.length > 1 ? (
          <p className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-sm text-secondary">
            <span>
              <span className="font-display text-2xl text-fg tabular-nums">{share.cards.length}</span> tracked
            </span>
            {counts.won ? (
              <span>
                <span className="font-display text-2xl text-fg tabular-nums">{counts.won}</span> live
              </span>
            ) : null}
            {counts.open ? (
              <span>
                <span className="font-display text-2xl text-fg tabular-nums">{counts.open}</span> in progress
              </span>
            ) : null}
          </p>
        ) : null}
      </section>
      {share.cards.length ? (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {share.cards.map((c, i) => (
            <Card key={i} c={c} />
          ))}
        </ul>
      ) : (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center text-sm text-muted">Nothing to show on this link right now.</p>
      )}
    </Shell>
  );
}
