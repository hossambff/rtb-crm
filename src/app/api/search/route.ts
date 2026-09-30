import { NextResponse, type NextRequest } from "next/server";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { dealAccessWhere, getCurrentUser } from "@/lib/rbac/server";
import { accountVisibilityWhere } from "@/lib/accounts/queries";
import { contactVisibilityWhere } from "@/lib/contacts/queries";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role === "pending") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ hits: [] });
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const [dealWhere, accWhere, conWhere] = await Promise.all([
    dealAccessWhere(user, "view"),
    // accounts module rules: owner scope + restricted (MNPI) access list; contacts also hide restricted accounts' people
    accountVisibilityWhere(user, "view"),
    contactVisibilityWhere(user, "view"),
  ]);

  const [deals, accounts, contacts] = await Promise.all([
    db
      .select({ id: s.deals.id, name: s.deals.name, pipeline: s.pipelines.key })
      .from(s.deals)
      .innerJoin(s.pipelines, eq(s.pipelines.id, s.deals.pipelineId))
      .where(and(dealWhere, ilike(s.deals.name, like)))
      .limit(8),
    db
      .select({ id: s.accounts.id, name: s.accounts.name, domain: s.accounts.domain })
      .from(s.accounts)
      .where(
        and(
          accWhere,
          or(ilike(s.accounts.name, like), ilike(s.accounts.domain, like)),
        ),
      )
      .limit(8),
    db
      .select({ id: s.contacts.id, name: s.contacts.fullName, email: s.contacts.email, title: s.contacts.title })
      .from(s.contacts)
      .where(and(conWhere, isNull(s.contacts.deletedAt), or(ilike(s.contacts.fullName, like), ilike(s.contacts.email, like))))
      .limit(8),
  ]);

  return NextResponse.json({
    hits: [
      ...deals.map((d) => ({ type: "deal", id: d.id, title: d.name, subtitle: d.pipeline, href: `/deals/${d.id}` })),
      ...accounts.map((a) => ({ type: "account", id: a.id, title: a.name, subtitle: a.domain ?? undefined, href: `/accounts/${a.id}` })),
      ...contacts.map((c) => ({ type: "contact", id: c.id, title: c.name, subtitle: c.title ?? c.email ?? undefined, href: `/contacts/${c.id}` })),
    ],
  });
}
