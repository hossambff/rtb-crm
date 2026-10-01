import { Users } from "lucide-react";
import type { AppUser } from "@/lib/rbac/server";
import { accountNoun, describeTouch, getRecentTouches, getRecentTouchesForDeal, latestPerPerson, type RecentTouch } from "@/lib/deals/collisions";
import { getVisibleAccount } from "@/lib/accounts/queries";

/**
 * Collision warning (V2 §C4) for a deal header: "Chris emailed this publisher 2 days ago" — other people's touches on the
 * deal's account in the last 14 days (+ upcoming meetings). Names and dates only. Renders nothing when clear.
 */
export async function CollisionNotice({
  user,
  dealId,
  known,
}: {
  user: AppUser;
  dealId: string;
  /** Pass when the caller already authorized the deal and loaded its account (deal page). */
  known?: { accountId: string | null; accountType: string | null; accountRestricted: boolean };
}) {
  const { touches, accountType } = await getRecentTouchesForDeal(user, dealId, { known });
  return <Notice touches={touches} accountType={accountType} />;
}

/** Same warning for account and contact pages (pass the account id; contact pages pass the contact's account). */
export async function AccountCollisionNotice({ user, accountId }: { user: AppUser; accountId: string | null | undefined }) {
  if (!accountId) return null;
  const [touches, account] = await Promise.all([getRecentTouches(user, accountId), getVisibleAccount(user, accountId)]);
  return <Notice touches={touches} accountType={account?.type ?? null} />;
}

function Notice({ touches, accountType }: { touches: RecentTouch[]; accountType: string | null }) {
  const people = latestPerPerson(touches);
  if (!people.length) return null;
  const now = new Date();
  const noun = accountNoun(accountType);
  const [first, ...rest] = people;
  return (
    <p className="flex min-w-0 items-start gap-2 text-[12px] text-secondary" role="note" aria-label="Others in touch with this account">
      <Users className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0">
        <span className="text-body">{describeTouch(first!, now, noun)}</span>
        {rest.length ? (
          <span className="text-muted" title={rest.map((p) => describeTouch(p, now, noun)).join("\n")}>
            {" "}
            · {rest.slice(0, 2).map((p) => p.userName.split(/\s+/)[0]).join(", ")}
            {rest.length > 2 ? ` +${rest.length - 2}` : ""} also in touch
          </span>
        ) : null}
        <span className="text-muted"> — coordinate before reaching out.</span>
      </span>
    </p>
  );
}
