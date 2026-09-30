import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { listAccounts, parseAccountListParams } from "@/lib/accounts/queries";
import { listContacts, parseContactListParams } from "@/lib/contacts/queries";
import { can, getHiddenFields, scopeFor } from "@/lib/rbac/server";
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

  // [csv header, entity field (for field-level security), value]
  type Col<R> = [string, string, (r: R) => unknown];
  const hidden = await getHiddenFields(user.role, entity === "accounts" ? "account" : "contact");
  if (hidden.has("*")) return json({ error: "You don't have permission to export." }, 403);
  const pick = <R,>(cols: Col<R>[]) => cols.filter(([, field]) => !hidden.has(field));
  let header: string[];
  let lines: unknown[][];
  if (entity === "accounts") {
    const res = await listAccounts(user, { ...parseAccountListParams(sp), page: 1, pageSize: MAX_ROWS });
    type R = (typeof res.rows)[number];
    const cols = pick<R>([
      ["id", "id", (r) => r.id],
      ["name", "name", (r) => r.name],
      ["domain", "domain", (r) => r.domain],
      ["type", "type", (r) => r.type],
      ["category", "category", (r) => r.category],
      ["lifecycle", "lifecycle", (r) => r.lifecycle],
      ["priority", "priority", (r) => r.priority],
      ["muu", "muu", (r) => r.muu],
      ["muu_source", "muuSource", (r) => r.muuSource],
      ["muu_confidence", "muuConfidence", (r) => r.muuConfidence],
      ["owner", "ownerId", (r) => r.ownerName],
      ["open_deals", "openDeals", (r) => r.openDeals],
      ["pipelines", "pipelines", (r) => r.pipelines],
      ["restricted", "restricted", (r) => r.restricted],
      ["updated_at", "updatedAt", (r) => r.updatedAt],
    ]);
    header = cols.map((c) => c[0]);
    // SEC L-9 / S-02: restricted (MNPI) accounts are never exported, even for access-list members (AUD-3).
    lines = res.rows.filter((r) => inScope(r.ownerId) && !r.restricted).map((r) => cols.map((c) => c[2](r)));
  } else {
    const res = await listContacts(user, { ...parseContactListParams(sp), page: 1, pageSize: MAX_ROWS });
    type R = (typeof res.rows)[number];
    const cols = pick<R>([
      ["id", "id", (r) => r.id],
      ["full_name", "fullName", (r) => r.fullName],
      ["title", "title", (r) => r.title],
      ["email", "email", (r) => r.email],
      ["phone", "phone", (r) => r.phone],
      ["account", "accountId", (r) => r.accountName],
      ["relationship_owner", "relationshipOwner", (r) => r.relationshipOwner],
      ["status", "status", (r) => r.status],
      ["do_not_contact", "doNotContact", (r) => r.doNotContact],
      ["last_contacted_at", "lastContactedAt", (r) => r.lastContactedAt],
    ]);
    header = cols.map((c) => c[0]);
    lines = res.rows.filter((r) => inScope(r.ownerId)).map((r) => cols.map((c) => c[2](r)));
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
