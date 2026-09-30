import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { listAccounts, parseAccountListParams } from "@/lib/accounts/queries";
import { listContacts, parseContactListParams } from "@/lib/contacts/queries";
import { can, scopeFor } from "@/lib/rbac/server";
import { authed, json } from "../shared";

const MAX_ROWS = 20_000;

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join("; ") : String(v);
  // neutralize spreadsheet formula injection and quote when needed
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV export (IMP-7): permission-gated by the `export` module (own / team / all) on top of normal visibility,
 * watermarked with the user and timestamp, audit-logged. Interns and commission reps have no export by default.
 */
export async function GET(req: NextRequest) {
  const user = await authed();
  if (user instanceof NextResponse) return user;
  const entity = req.nextUrl.searchParams.get("entity");
  if (entity !== "accounts" && entity !== "contacts") return json({ error: "Unknown export" }, 400);
  const scope = await scopeFor(user, "export", "export");
  if (scope === "none" || !(await can(user, entity, "view"))) return json({ error: "You don't have permission to export." }, 403);
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const inScope = (ownerId: string | null) => scope === "all" || scope === "pipeline" || (scope === "team" ? !!ownerId && user.teamMemberIds.includes(ownerId) : ownerId === user.id);

  let header: string[];
  let lines: unknown[][];
  if (entity === "accounts") {
    const res = await listAccounts(user, { ...parseAccountListParams(sp), page: 1, pageSize: MAX_ROWS });
    header = ["id", "name", "domain", "type", "category", "lifecycle", "priority", "muu", "muu_source", "muu_confidence", "owner", "open_deals", "pipelines", "restricted", "updated_at"];
    lines = res.rows
      .filter((r) => inScope(r.ownerId))
      .map((r) => [r.id, r.name, r.domain, r.type, r.category, r.lifecycle, r.priority, r.muu, r.muuSource, r.muuConfidence, r.ownerName, r.openDeals, r.pipelines, r.restricted, r.updatedAt]);
  } else {
    const res = await listContacts(user, { ...parseContactListParams(sp), page: 1, pageSize: MAX_ROWS });
    header = ["id", "full_name", "title", "email", "phone", "account", "relationship_owner", "status", "do_not_contact", "last_contacted_at"];
    lines = res.rows
      .filter((r) => inScope(r.ownerId))
      .map((r) => [r.id, r.fullName, r.title, r.email, r.phone, r.accountName, r.relationshipOwner, r.status, r.doNotContact, r.lastContactedAt]);
  }
  const stamp = new Date().toISOString();
  const csv = [`# Roundtable Sales OS — confidential. Exported by ${user.email} at ${stamp}. ${lines.length} rows.`, header.join(","), ...lines.map((l) => l.map(csvCell).join(","))].join("\r\n");
  await audit({ actorId: user.id, action: `export.${entity}`, entity, after: { rows: lines.length, filters: sp, scope } });
  return new NextResponse(`﻿${csv}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rtb-${entity}-${stamp.slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
